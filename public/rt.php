<?php
// Renfe GTFS-Realtime JSON proxy (the feed has no CORS headers). Whitelist only: no other URL
// is reachable. Responses are cached in the system temp dir for 15 s.
$allowed = ['trip_updates', 'alerts'];
$f = $_GET['f'] ?? '';
if (!is_string($f) || !in_array($f, $allowed, true)) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo '{"error":"bad feed"}';
    exit;
}

$cache = sys_get_temp_dir() . '/madrid-transit-' . $f . '.json';
$fresh = is_file($cache) && time() - filemtime($cache) < 15;
if (!$fresh) {
    $ctx = stream_context_create(['http' => ['timeout' => 8, 'header' => "Accept: application/json\r\n"]]);
    $body = @file_get_contents('https://gtfsrt.renfe.com/' . $f . '.json', false, $ctx);
    if ($body !== false && $body !== '') {
        // Write atomically so concurrent requests never read a half-written file.
        $tmp = $cache . '.' . getmypid();
        file_put_contents($tmp, $body);
        rename($tmp, $cache);
    } elseif (!is_file($cache)) {
        http_response_code(502);
        header('Content-Type: application/json');
        echo '{"error":"upstream unavailable"}';
        exit;
    }
}

header('Content-Type: application/json');
header('Cache-Control: public, max-age=15');
readfile($cache);
