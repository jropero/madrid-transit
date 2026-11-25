<?php
// Whitelist proxy for two upstreams that send no CORS headers; no other URL is reachable.
//   ?f=trip_updates|alerts  Renfe GTFS-RT JSON, cached 15 s in the system temp dir.
//   ?f=crtm&stop=8_16578    CRTM stop times (undocumented website endpoint, may change or
//                           break), cached 60 s per stop. `stop` must match ^(8|10)_\d{1,6}$.

function fail(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: application/json');
    echo '{"error":"' . $msg . '"}';
    exit;
}

$f = $_GET['f'] ?? '';
if (!is_string($f)) {
    fail(400, 'bad feed');
}

if ($f === 'crtm') {
    $stop = $_GET['stop'] ?? '';
    // \z (not $) so a trailing newline cannot slip through.
    if (!is_string($stop) || !preg_match('/^(8|10)_\d{1,6}\z/', $stop)) {
        fail(400, 'bad stop');
    }
    $url = 'https://www.crtm.es/widgets/api/GetStopsTimes.php?codStop=' . $stop . '&type=1&orderBy=2&stopTimesByIti=3';
    $cache = sys_get_temp_dir() . '/madrid-transit-crtm-' . $stop . '.json';
    $ttl = 60;
} elseif (in_array($f, ['trip_updates', 'alerts'], true)) {
    $url = 'https://gtfsrt.renfe.com/' . $f . '.json';
    $cache = sys_get_temp_dir() . '/madrid-transit-' . $f . '.json';
    $ttl = 15;
} else {
    fail(400, 'bad feed');
}

$fresh = is_file($cache) && time() - filemtime($cache) < $ttl;
if (!$fresh) {
    $ctx = stream_context_create(['http' => ['timeout' => 8, 'header' => "Accept: application/json\r\n"]]);
    $body = @file_get_contents($url, false, $ctx);
    // CRTM answers errors with HTML or text: only cache something that decodes as JSON.
    if ($body !== false && $body !== '' && json_decode($body) !== null) {
        // Write atomically so concurrent requests never read a half-written file.
        $tmp = $cache . '.' . getmypid();
        file_put_contents($tmp, $body);
        rename($tmp, $cache);
    } elseif (!is_file($cache)) {
        fail(502, 'upstream unavailable');
    }
}

header('Content-Type: application/json');
header('Cache-Control: public, max-age=' . $ttl);
readfile($cache);
