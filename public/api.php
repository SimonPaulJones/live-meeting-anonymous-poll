<?php
// Live Poll API. Works on PHP 5.6 and later, so: no ??, no random_bytes, no type hints.
// Every request is a POST of a JSON object {a: action, t: token, c: clientId, ...}.
// State lives in data/state.json; writers hold an flock on data/lock and replace the file atomically,
// so readers never need a lock.

// Starting passwords come from config.php (copy config.example.php). The host can change them from the ⋯ menu;
// the current ones are then kept in data/config.php.
if (file_exists(__DIR__ . '/config.php')) require __DIR__ . '/config.php';
define('DATA_DIR', __DIR__ . '/data');
define('STATE_FILE', DATA_DIR . '/state.json');
define('PRESENCE_TTL', 75);     // seconds a browser counts as "here" without a check-in
define('PRESENCE_REFRESH', 20); // re-record a browser's check-in when older than this
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

// Passwords and token generations. Bumping a role's generation logs out every browser holding that role's token.
$CONFIG = null;
function config() {
    global $CONFIG;
    if ($CONFIG) return $CONFIG;
    $CONFIG = array('voter' => DEFAULT_VOTER_PASSWORD, 'admin' => DEFAULT_ADMIN_PASSWORD, 'voterGen' => 1, 'adminGen' => 1);
    $file = DATA_DIR . '/config.php';
    if (file_exists($file)) {
        $lines = file($file);
        $saved = isset($lines[1]) ? json_decode($lines[1], true) : null;
        if (is_array($saved)) $CONFIG = array_merge($CONFIG, $saved);
    }
    return $CONFIG;
}

// Call only while holding the lock (inside update_state).
function save_config($c) {
    global $CONFIG;
    $file = DATA_DIR . '/config.php';
    $tmp = $file . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, "<?php exit; ?>\n" . json_encode($c) . "\n");
    @chmod($tmp, 0600);
    rename($tmp, $file);
    $CONFIG = $c;
}

function token_for($role) {
    $c = config();
    $gen = (int)$c[$role . 'Gen'];
    return $role . '.' . $gen . '.' . hash_hmac('sha256', $role . '|' . $gen, secret());
}

// Returns 'admin', 'voter', 'kicked' (a valid but logged-out token) or null.
function role_of($token) {
    if (!is_string($token)) return null;
    foreach (array('admin', 'voter') as $role) {
        if (hash_equals(token_for($role), $token)) return $role;
    }
    $parts = explode('.', $token);
    if (count($parts) === 3 && in_array($parts[0], array('admin', 'voter'), true)
        && hash_equals(hash_hmac('sha256', $parts[0] . '|' . (int)$parts[1], secret()), $parts[2])) return 'kicked';
    return null;
}

function clean_password($v) {
    return strtolower(trim((string)$v));
}

function default_state() {
    return array('rev' => 1, 'poll' => null, 'votes' => array(), 'seen' => array());
}

function read_state() {
    $raw = @file_get_contents(STATE_FILE);
    $s = $raw ? json_decode($raw, true) : null;
    if (!is_array($s)) return default_state();
    if (!isset($s['votes']) || !is_array($s['votes'])) $s['votes'] = array();
    if (!isset($s['seen']) || !is_array($s['seen'])) $s['seen'] = array();
    return $s;
}

// Run $fn(&$state) under an exclusive lock and save the result.
function update_state($fn) {
    $lock = fopen(DATA_DIR . '/lock', 'c');
    flock($lock, LOCK_EX);
    $s = read_state();
    $result = call_user_func_array($fn, array(&$s));
    $now = time();
    foreach ($s['seen'] as $c => $info) {
        if ($now - $info['t'] > PRESENCE_TTL) unset($s['seen'][$c]);
    }
    $tmp = STATE_FILE . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, json_encode($s));
    rename($tmp, STATE_FILE);
    flock($lock, LOCK_UN);
    fclose($lock);
    return array($s, $result);
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
    if (!$poll) return $v;
    if ($client !== '' && isset($s['votes'][$client])) $v['myVote'] = $s['votes'][$client];
    if ($role === 'admin' || $poll['show']['attendees']) $v['attendees'] = $present;
    if ($poll['live'] || $poll['revealed']) {
        $counts = array_fill(0, count($poll['options']), 0);
        foreach ($s['votes'] as $choice) {
            if (isset($counts[$choice])) $counts[$choice]++;
        }
        $v['results'] = array('counts' => $counts, 'nonvoters' => $presentNonVoters);
    }
    return $v;
}

$in = json_decode(file_get_contents('php://input'), true);
if (!is_array($in)) out(array('error' => 'bad request'), 400);
$action = isset($in['a']) ? $in['a'] : '';
$client = isset($in['c']) && preg_match('/^[a-zA-Z0-9]{8,64}$/', $in['c']) ? $in['c'] : '';

if (!is_dir(DATA_DIR)) out(array('error' => 'data folder missing'), 500);
if (!defined('DEFAULT_VOTER_PASSWORD') || !defined('DEFAULT_ADMIN_PASSWORD')) {
    out(array('error' => 'Copy config.example.php to config.php and set the passwords'), 500);
}

if ($action === 'login') {
    $pw = clean_password(isset($in['password']) ? $in['password'] : '');
    $c = config();
    if ($pw !== '' && $pw === $c['admin']) out(array('role' => 'admin', 'token' => token_for('admin')));
    if ($pw !== '' && $pw === $c['voter']) out(array('role' => 'voter', 'token' => token_for('voter')));
    out(array('error' => 'wrong password'), 401);
}

$role = role_of(isset($in['t']) ? $in['t'] : null);
if ($role === 'kicked') out(array('error' => 'kicked'), 401);
if (!$role) out(array('error' => 'login needed'), 401);
$isAdmin = $role === 'admin';

switch ($action) {
    case 'state':
        $s = read_state();
        $seen = ($client !== '' && isset($s['seen'][$client])) ? $s['seen'][$client] : null;
        if ($client !== '' && (!$seen || time() - $seen['t'] > PRESENCE_REFRESH || !empty($seen['admin']) !== $isAdmin)) {
            list($s) = update_state(function (&$s) use ($client, $isAdmin) {
                $s['seen'][$client] = array('t' => time(), 'admin' => $isAdmin);
            });
        }
        out(view($s, $role, $client));

    case 'leave':
        if ($client === '') out(array('ok' => true));
        update_state(function (&$s) use ($client) { unset($s['seen'][$client]); });
        out(array('ok' => true));

    case 'vote':
        if ($client === '') out(array('error' => 'no client id'), 400);
        $pid = isset($in['pid']) ? $in['pid'] : '';
        $choice = isset($in['choice']) ? $in['choice'] : null;
        list($s, $err) = update_state(function (&$s) use ($client, $pid, $choice, $isAdmin) {
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
        if ($err) out(array('error' => $err) + view($s, $role, $client), 409);
        out(view($s, $role, $client));
}

if (!$isAdmin) out(array('error' => 'admin only'), 403);

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
        list($s) = update_state(function (&$s) use ($poll) {
            $s['poll'] = $poll;
            $s['votes'] = array();
            $s['rev']++;
        });
        out(view($s, $role, $client));

    case 'set':
        // Change how the running poll is shown: reveal, open, live, chart, show.
        list($s, $err) = update_state(function (&$s) use ($in) {
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
        if ($err) out(array('error' => $err), 409);
        out(view($s, $role, $client));

    case 'config':
        $c = config();
        out(array('voter' => $c['voter']));

    case 'passwords':
        // Changing the spectator password only affects new logins. Changing the host password also logs out any
        // other host browser; this one gets a fresh token.
        $voter = isset($in['voter']) ? clean_password($in['voter']) : '';
        $admin = isset($in['admin']) ? clean_password($in['admin']) : '';
        $c = config();
        $newVoter = $voter !== '' ? $voter : $c['voter'];
        $newAdmin = $admin !== '' ? $admin : $c['admin'];
        if (strlen($newVoter) > 40 || strlen($newAdmin) > 40) out(array('error' => 'Passwords can be 40 characters at most'), 400);
        if ($newVoter === $newAdmin) out(array('error' => 'The two passwords must be different'), 400);
        update_state(function (&$s) use ($newVoter, $newAdmin) {
            $c = config();
            if ($newAdmin !== $c['admin']) $c['adminGen'] = (int)$c['adminGen'] + 1;
            $c['voter'] = $newVoter;
            $c['admin'] = $newAdmin;
            save_config($c);
        });
        out(array('voter' => $newVoter, 'token' => token_for('admin')));

    case 'kick':
        list($s) = update_state(function (&$s) {
            $c = config();
            $c['voterGen'] = (int)$c['voterGen'] + 1;
            save_config($c);
            foreach ($s['seen'] as $id => $info) {
                if (empty($info['admin'])) unset($s['seen'][$id]);
            }
            $s['rev']++;
        });
        out(view($s, $role, $client));

    case 'end':
        list($s) = update_state(function (&$s) {
            $s['poll'] = null;
            $s['votes'] = array();
            $s['rev']++;
        });
        out(view($s, $role, $client));
}

out(array('error' => 'unknown action'), 400);
