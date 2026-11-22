<?php
// Serves the page for a poll link (/<room id>, see .htaccess). A poll that doesn't exist gets a 404 status; the
// page itself then shows "Poll not found".
$room = isset($_GET['r']) && preg_match('/^[a-f0-9]{16}$/', $_GET['r']) ? $_GET['r'] : '';
if ($room === '' || !file_exists(__DIR__ . '/data/rooms/' . $room . '.json')) http_response_code(404);
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
readfile(__DIR__ . '/index.html');
