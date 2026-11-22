<?php
// Live Poll API. Works on PHP 5.6 and later, so: no ??, no random_bytes, no type hints.
// Every request is a POST of a JSON object {a: action, r: roomId, t: hostToken, c: clientId, ...}.
//
// Each host login creates a room: its own poll, votes and people, saved as data/rooms/<id>.json. Voters join a
// room just by opening its link (the long random id is the only key). The host's token is an HMAC of the room id,
// so it can't be guessed or reused for another room. Rooms nobody has opened for ROOM_TTL are deleted.
// Writers hold an flock on data/lock and replace the room file atomically, so readers never need a lock.

if (file_exists(__DIR__ . '/config.php')) require __DIR__ . '/config.php';
if (!defined('ADMIN_PASSWORD') && defined('DEFAULT_ADMIN_PASSWORD')) define('ADMIN_PASSWORD', DEFAULT_ADMIN_PASSWORD);
if (!defined('ROOM_TTL_HOURS')) define('ROOM_TTL_HOURS', 24);
define('DATA_DIR', __DIR__ . '/data');
define('ROOMS_DIR', DATA_DIR . '/rooms');
define('ROOM_TTL', ROOM_TTL_HOURS * 3600);
define('PRESENCE_TTL', 75);     // seconds a browser counts as "here" without a check-in
define('PRESENCE_REFRESH', 20); // re-record a browser's check-in when older than this (also keeps the room alive)
define('MAX_OPTIONS', 8);
define('MAX_TEXT', 120);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function secret() {
    $file = DATA_DIR . '/secret.php';
    if (!file_exists($file)) {
        $s = bin2hex(openssl_random_pseudo_bytes(32));
        file_put_contents($file, "<?php exit; ?>\n" . $s . "\n", LOCK_EX);
        @chmod($file, 0600);
    }
    $lines = file($file);
    return trim($lines[1]);
}

function host_token($room) {
    return hash_hmac('sha256', 'host|' . $room, secret());
}

function clean_password($v) {
    return strtolower(trim((string)$v));
}

function room_file($room) {
    return ROOMS_DIR . '/' . $room . '.json';
}

function default_state() {
    return array('rev' => 1, 'created' => time(), 'poll' => null, 'votes' => array(), 'seen' => array());
}

// Returns the room's state, or null if it doesn't exist (never created, deleted or cleaned up).
function read_state($room) {
    $raw = @file_get_contents(room_file($room));
    $s = $raw ? json_decode($raw, true) : null;
    if (!is_array($s)) return null;
    if (!isset($s['votes']) || !is_array($s['votes'])) $s['votes'] = array();
    if (!isset($s['seen']) || !is_array($s['seen'])) $s['seen'] = array();
    return $s;
}

function write_state($room, $s) {
    $tmp = room_file($room) . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, json_encode($s));
    @chmod($tmp, 0600);
    rename($tmp, room_file($room));
}

function with_lock($fn) {
    $lock = fopen(DATA_DIR . '/lock', 'c');
    flock($lock, LOCK_EX);
    $result = call_user_func($fn);
    flock($lock, LOCK_UN);
    fclose($lock);
    return $result;
}

// Run $fn(&$state) under the lock and save the result. Returns array(state, result), or array(null, null) if the
// room has gone.
function update_state($room, $fn) {
    return with_lock(function () use ($room, $fn) {
        $s = read_state($room);
        if (!$s) return array(null, null);
        $result = call_user_func_array($fn, array(&$s));
        $now = time();
        foreach ($s['seen'] as $c => $info) {
            if ($now - $info['t'] > PRESENCE_TTL) unset($s['seen'][$c]);
        }
        write_state($room, $s);
        return array($s, $result);
    });
}

// Delete rooms that nobody has had open for ROOM_TTL. A room file is rewritten at least every PRESENCE_REFRESH
// seconds while anyone has the page open, so its modification time is its last activity.
function clean_up_rooms() {
    $now = time();
    foreach (glob(ROOMS_DIR . '/*') as $f) {
        $age = $now - @filemtime($f);
        if (substr($f, -5) === '.json' ? $age > ROOM_TTL : $age > 600) @unlink($f);
    }
}

function clean_text($v) {
    $v = trim(preg_replace('/\s+/u', ' ', (string)$v));
    return function_exists('mb_substr') ? mb_substr($v, 0, MAX_TEXT, 'UTF-8') : substr($v, 0, MAX_TEXT);
}

function clean_show($show) {
    $out = array();
    foreach (array('attendees', 'counts', 'percent', 'nonvoters') as $k) {
        $out[$k] = is_array($show) && !empty($show[$k]);
    }
    return $out;
}

function clean_chart($chart) {
    return in_array($chart, array('bar', 'pie', 'numbers'), true) ? $chart : 'bar';
}

// What one browser is allowed to see. Results are left out entirely while they are hidden.
function view($s, $role, $client) {
    $now = time();
    $present = 0;
    $presentNonVoters = 0;
    foreach ($s['seen'] as $c => $info) {
        if ($now - $info['t'] > PRESENCE_TTL || !empty($info['admin'])) continue;
        $present++;
        if (!isset($s['votes'][$c])) $presentNonVoters++;
    }
    $poll = $s['poll'];
    $v = array('role' => $role, 'rev' => $s['rev'], 'poll' => $poll, 'myVote' => null,
               'voted' => count($s['votes']), 'attendees' => null, 'results' => null);
    if ($role === 'admin') $v['attendees'] = $present;
    if (!$poll) return $v;
    if ($client !== '' && isset($s['votes'][$client])) $v['myVote'] = $s['votes'][$client];
    if ($poll['show']['attendees']) $v['attendees'] = $present;
    if ($poll['live'] || $poll['revealed']) {
        $counts = array_fill(0, count($poll['options']), 0);
        foreach ($s['votes'] as $choice) {
            if (isset($counts[$choice])) $counts[$choice]++;
        }
        $v['results'] = array('counts' => $counts, 'nonvoters' => $presentNonVoters);
    }
    return $v;
}

function gone() {
    out(array('error' => 'gone'), 404);
}

$in = json_decode(file_get_contents('php://input'), true);
if (!is_array($in)) out(array('error' => 'bad request'), 400);
$action = isset($in['a']) ? $in['a'] : '';
$client = isset($in['c']) && preg_match('/^[a-zA-Z0-9]{8,64}$/', $in['c']) ? $in['c'] : '';

if (!is_dir(DATA_DIR)) out(array('error' => 'data folder missing'), 500);
if (!is_dir(ROOMS_DIR) && !@mkdir(ROOMS_DIR, 0700)) out(array('error' => 'Can’t create the data/rooms folder'), 500);
if (!defined('ADMIN_PASSWORD') || ADMIN_PASSWORD === '') {
    out(array('error' => 'Copy config.example.php to config.php and set the host password'), 500);
}

// Logging in creates a fresh room for this host. Hosts can't see or list anyone else's rooms.
if ($action === 'login') {
    $pw = clean_password(isset($in['password']) ? $in['password'] : '');
    if ($pw === '' || !hash_equals(clean_password(ADMIN_PASSWORD), $pw)) {
        sleep(1); // slow down password guessing
        out(array('error' => 'wrong password'), 401);
    }
    $room = with_lock(function () {
        clean_up_rooms();
        do { $room = bin2hex(openssl_random_pseudo_bytes(8)); } while (file_exists(room_file($room)));
        write_state($room, default_state());
        return $room;
    });
    out(array('room' => $room, 'token' => host_token($room)));
}

$room = isset($in['r']) && is_string($in['r']) && preg_match('/^[a-f0-9]{16}$/', $in['r']) ? $in['r'] : '';
if ($room === '') gone();
$isAdmin = isset($in['t']) && is_string($in['t']) && hash_equals(host_token($room), $in['t']);
$role = $isAdmin ? 'admin' : 'voter';

switch ($action) {
    case 'state':
        $s = read_state($room);
        if (!$s) gone();
        $seen = ($client !== '' && isset($s['seen'][$client])) ? $s['seen'][$client] : null;
        if ($client !== '' && (!$seen || time() - $seen['t'] > PRESENCE_REFRESH || !empty($seen['admin']) !== $isAdmin)) {
            list($s) = update_state($room, function (&$s) use ($client, $isAdmin) {
                $s['seen'][$client] = array('t' => time(), 'admin' => $isAdmin);
            });
            if (!$s) gone();
            if (mt_rand(1, 200) === 1) with_lock('clean_up_rooms');
        }
        out(view($s, $role, $client));

    case 'leave':
        if ($client !== '') update_state($room, function (&$s) use ($client) { unset($s['seen'][$client]); });
        out(array('ok' => true));

    case 'vote':
        if ($client === '') out(array('error' => 'no client id'), 400);
        $pid = isset($in['pid']) ? $in['pid'] : '';
        $choice = isset($in['choice']) ? $in['choice'] : null;
        list($s, $err) = update_state($room, function (&$s) use ($client, $pid, $choice, $isAdmin) {
            $p = $s['poll'];
            if (!$p || $p['id'] !== $pid) return 'This question has changed';
            if (!$p['open']) return 'Voting has closed';
            if ($choice === null) {
                unset($s['votes'][$client]);
            } else {
                if (!is_int($choice) || $choice < 0 || $choice >= count($p['options'])) return 'bad choice';
                $s['votes'][$client] = $choice;
            }
            $s['seen'][$client] = array('t' => time(), 'admin' => $isAdmin);
            $s['rev']++;
            return null;
        });
        if (!$s) gone();
        if ($err) out(array('error' => $err) + view($s, $role, $client), 409);
        out(view($s, $role, $client));
}

if (!$isAdmin) out(array('error' => 'host only'), 403);

switch ($action) {
    case 'start':
        $options = array();
        foreach ((isset($in['options']) && is_array($in['options'])) ? $in['options'] : array() as $o) {
            $o = clean_text($o);
            if ($o !== '' && count($options) < MAX_OPTIONS) $options[] = $o;
        }
        if (count($options) < 2) out(array('error' => 'Add at least two options'), 400);
        $poll = array(
            'id' => bin2hex(openssl_random_pseudo_bytes(6)),
            'question' => clean_text(isset($in['question']) ? $in['question'] : ''),
            'options' => $options,
            'live' => !empty($in['live']),
            'revealed' => false,
            'open' => true,
            'chart' => clean_chart(isset($in['chart']) ? $in['chart'] : ''),
            'show' => clean_show(isset($in['show']) ? $in['show'] : null),
        );
        list($s) = update_state($room, function (&$s) use ($poll) {
            $s['poll'] = $poll;
            $s['votes'] = array();
            $s['rev']++;
        });
        if (!$s) gone();
        out(view($s, $role, $client));

    case 'set':
        // Change how the running poll is shown: reveal, open, live, chart, show.
        list($s, $err) = update_state($room, function (&$s) use ($in) {
            if (!$s['poll']) return 'No poll running';
            $p = &$s['poll'];
            foreach (array('revealed', 'open', 'live') as $k) {
                if (array_key_exists($k, $in)) $p[$k] = !empty($in[$k]);
            }
            if (isset($in['chart'])) $p['chart'] = clean_chart($in['chart']);
            if (isset($in['show'])) $p['show'] = clean_show($in['show']);
            $s['rev']++;
            return null;
        });
        if (!$s) gone();
        if ($err) out(array('error' => $err), 409);
        out(view($s, $role, $client));

    case 'end':
        list($s) = update_state($room, function (&$s) {
            $s['poll'] = null;
            $s['votes'] = array();
            $s['rev']++;
        });
        if (!$s) gone();
        out(view($s, $role, $client));

    case 'delete':
        // Removes the room for good: everyone with the link sees "This poll has ended".
        with_lock(function () use ($room) { @unlink(room_file($room)); });
        out(array('ok' => true));
}

out(array('error' => 'unknown action'), 400);
