<?php
// Serves the page for a poll link (…/<room id>: .htaccess on Apache; on nginx, a location that runs this file for
// that path). A poll that doesn't exist gets a 404 status; the page itself then shows "404 Poll not found".
$room = isset($_GET['r']) ? $_GET['r'] : '';
if ($room === '' && isset($_SERVER['REQUEST_URI']) && preg_match('#/([a-f0-9]{16})/?(\?.*)?$#', $_SERVER['REQUEST_URI'], $m)) $room = $m[1];
if (!preg_match('/^[a-f0-9]{16}$/', $room)) $room = '';
if ($room === '' || !file_exists(__DIR__ . '/data/rooms/' . $room . '.json')) http_response_code(404);
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
readfile(__DIR__ . '/index.html');
