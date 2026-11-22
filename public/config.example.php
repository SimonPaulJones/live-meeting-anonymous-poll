<?php
// Copy this file to config.php and choose the host password (not case sensitive).
// Every host logs in with it; each login starts a new poll with its own link for voters, who need no password.
define('ADMIN_PASSWORD', 'change-me');
// Polls nobody has had open for this many hours are deleted (hosts can also delete their own).
define('ROOM_TTL_HOURS', 24);
