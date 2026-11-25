<?php
// Whitelist proxy for upstreams that send no CORS headers; no other URL is reachable.
//   ?f=trip_updates|alerts  Renfe GTFS-RT JSON, cached 15 s in the system temp dir.
//   ?f=crtm&stop=8_16578    CRTM stop times (undocumented website endpoint, may change or
//                           break), cached 60 s per stop. `stop` must match ^(4|6|8|10)_\d{1,6}$.
//   ?f=emt&stop=72          EMT Madrid MobilityLabs bus arrivals (needs ../../emt.json, outside the
//                           webroot, written by the deploy workflow), cached 30 s per stop. `stop`
//                           must match ^\d{1,6}$. The credentials and the access token are never
//                           output or logged.

function fail(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: application/json');
    echo '{"error":"' . $msg . '"}';
    exit;
}

// ---------------------------------------------------------------- EMT Madrid (MobilityLabs)

const EMT_HOST = 'https://openapi.emtmadrid.es/';

// One HTTPS request to the EMT host (cURL when available, else a stream context).
// Returns [http status, body or null]; any other host is refused.
function emt_http(string $method, string $url, array $headers, ?string $body = null): array {
    if (strpos($url, EMT_HOST) !== 0) {
        return [0, null];
    }
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $out = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return [$status, is_string($out) ? $out : null];
    }
    $http = ['method' => $method, 'timeout' => 8, 'ignore_errors' => true, 'follow_location' => 0,
        'header' => implode("\r\n", $headers) . "\r\n"];
    if ($body !== null) {
        $http['content'] = $body;
    }
    $out = @file_get_contents($url, false, stream_context_create(['http' => $http]));
    $status = 0;
    if (isset($http_response_header[0]) && preg_match('#^HTTP/\S+ (\d{3})#', $http_response_header[0], $m)) {
        $status = (int) $m[1];
    }
    return [$status, is_string($out) ? $out : null];
}

// Atomic write: a temp file in the same directory, then rename.
function emt_write(string $path, string $data, int $mode): void {
    $tmp = $path . '.' . getmypid();
    $old = umask(0077);
    $ok = file_put_contents($tmp, $data) !== false;
    umask($old);
    if ($ok && chmod($tmp, $mode)) {
        rename($tmp, $path);
    } else {
        @unlink($tmp);
    }
}

// A header value must be printable ASCII (space included, for passwords) with no CR/LF,
// control or non-ASCII characters, so it cannot inject headers.
function emt_clean($v): bool {
    return is_string($v) && preg_match('/^[\x20-\x7e]{1,2048}\z/', $v) === 1;
}

// {"email":…,"password":…} and/or {"clientId":…,"passKey":…} from the config file outside the
// webroot. Only complete, valid pairs are returned; a present but invalid pair (for example a
// non-ASCII password) with no valid one is 'emt config invalid'.
function emt_config(): array {
    $raw = @file_get_contents(__DIR__ . '/../../emt.json');
    $cfg = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($cfg)) {
        fail(503, 'emt not configured');
    }
    $out = [];
    $invalid = false;
    foreach ([['email', 'password'], ['clientId', 'passKey']] as [$a, $b]) {
        $x = $cfg[$a] ?? null;
        $y = $cfg[$b] ?? null;
        if ($x === null && $y === null) {
            continue;
        }
        if (emt_clean($x) && emt_clean($y)) {
            $out[$a] = $x;
            $out[$b] = $y;
        } else {
            $invalid = true;
        }
    }
    if ($out === []) {
        fail(503, $invalid ? 'emt config invalid' : 'emt not configured');
    }
    return $out;
}

// Seconds-to-live of a fresh login: tokenSecExpiration (the API extends it on each call).
function emt_ttl(array $d): int {
    if (isset($d['tokenSecExpiration']) && is_numeric($d['tokenSecExpiration'])) {
        return (int) $d['tokenSecExpiration'];
    }
    return 3600; // absent: documented sessions last far longer
}

// Logs in and caches the token (file mode 600 in the temp dir); null on failure. Prefers
// email/password headers, else X-ClientId/passKey (legacy). Wrong user or password ("92"/"89")
// ends the request with 502 instead of retrying.
function emt_login(array $cfg, string $tokenFile): ?string {
    if (isset($cfg['email'], $cfg['password'])) {
        $auth = ['email: ' . $cfg['email'], 'password: ' . $cfg['password']];
    } else {
        $auth = ['X-ClientId: ' . $cfg['clientId'], 'passKey: ' . $cfg['passKey']];
    }
    [$status, $body] = emt_http('GET', EMT_HOST . 'v1/mobilitylabs/user/login/', array_merge($auth, ['Accept: application/json']));
    $j = $body !== null ? json_decode($body, true) : null;
    $code = is_array($j) ? ($j['code'] ?? '') : '';
    if (in_array($code, ['92', '89'], true)) {
        fail(502, 'emt login failed');
    }
    $d = $j['data'][0] ?? null;
    if ($status !== 200 || !in_array($code, ['00', '01'], true) || !is_array($d) || !emt_clean($d['accessToken'] ?? null)) {
        return null;
    }
    $exp = time() + emt_ttl($d);
    emt_write($tokenFile, json_encode(['token' => $d['accessToken'], 'exp' => $exp]), 0600);
    return $d['accessToken'];
}

// Cached token while it has more than 60 s left, else a new login.
function emt_token(array $cfg, bool $force): ?string {
    $tokenFile = sys_get_temp_dir() . '/madrid-transit-emt-token.json';
    $c = $force || !is_file($tokenFile) ? null : json_decode((string) @file_get_contents($tokenFile), true);
    if (is_array($c) && emt_clean($c['token'] ?? null) && ($c['exp'] ?? 0) - 60 > time()) {
        return $c['token'];
    }
    return emt_login($cfg, $tokenFile);
}

// Arrivals for a stop: [decoded JSON or null, raw body]. Null decoded = transport or HTTP failure.
function emt_arrivals(string $stop, string $token): array {
    [$status, $body] = emt_http(
        'POST',
        EMT_HOST . 'v2/transport/busemtmad/stops/' . $stop . '/arrives/',
        ['accessToken: ' . $token, 'Content-Type: application/json', 'Accept: application/json'],
        json_encode([
            'cultureInfo' => 'ES',
            'Text_StopRequired_YN' => 'N',
            'Text_EstimationsRequired_YN' => 'Y',
            'Text_IncidencesRequired_YN' => 'Y',
            'DateTime_Referenced_Incidencies_YYYYMMDD' => (new DateTime('now', new DateTimeZone('Europe/Madrid')))->format('Ymd'),
        ])
    );
    $j = $status === 200 && $body !== null ? json_decode($body, true) : null;
    return [is_array($j) ? $j : null, $body];
}

// Serves the arrivals JSON of one stop (30 s cache) and exits. Re-logs in once on a token error.
function emt_serve(string $stop): void {
    $ttl = 30;
    $cache = sys_get_temp_dir() . '/madrid-transit-emt-' . $stop . '.json';
    if (!(is_file($cache) && time() - filemtime($cache) < $ttl)) {
        $cfg = emt_config();
        $code = null;
        $body = null;
        foreach ([false, true] as $force) {
            $token = emt_token($cfg, $force);
            if ($token === null) {
                continue;
            }
            [$j, $body] = emt_arrivals($stop, $token);
            $code = $j['code'] ?? null;
            if ($code === '00' || $code === '98') {
                break; // "98": API limit, a new login would not help
            }
        }
        if ($code === '00') {
            emt_write($cache, (string) $body, 0644);
        } elseif ($code === '98') {
            fail(429, 'emt limit exceeded');
        } elseif ($code === '80') {
            fail(404, 'emt stop not found');
        } elseif (!is_file($cache)) {
            fail(502, 'upstream unavailable');
        }
    }
    header('Content-Type: application/json');
    header('Cache-Control: public, max-age=30');
    readfile($cache);
    exit;
}

$f = $_GET['f'] ?? '';
if (!is_string($f)) {
    fail(400, 'bad feed');
}

if ($f === 'emt') {
    $stop = $_GET['stop'] ?? '';
    // \z (not $) so a trailing newline cannot slip through.
    if (!is_string($stop) || !preg_match('/^\d{1,6}\z/', $stop)) {
        fail(400, 'bad stop');
    }
    emt_serve($stop);
} elseif ($f === 'crtm') {
    $stop = $_GET['stop'] ?? '';
    // \z (not $) so a trailing newline cannot slip through.
    if (!is_string($stop) || !preg_match('/^(4|6|8|10)_\d{1,6}\z/', $stop)) {
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
