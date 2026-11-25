<?php
// Regenerates php-vectors.json with PHP's own openssl, in the exact wire format Illuminate's Encrypter writes
// (written from the published format, no framework code used). Fixed keys and fake values only: run `php gen-php-vectors.php > php-vectors.json`.
// Randomness (iv) is fresh per run, so the vectors change when regenerated; the Go test only needs them to be valid.

function enc(string $plain, string $cipher, string $key): string {
    $ivLen = openssl_cipher_iv_length($cipher);
    $iv = random_bytes($ivLen);
    $gcm = str_ends_with($cipher, '-gcm');
    $tag = '';
    $value = $gcm
        ? openssl_encrypt($plain, $cipher, $key, 0, $iv, $tag)
        : openssl_encrypt($plain, $cipher, $key, 0, $iv);
    $ivB = base64_encode($iv);
    $tagB = base64_encode($gcm ? $tag : '');
    $mac = $gcm ? '' : hash_hmac('sha256', $ivB . $value, $key);
    return base64_encode(json_encode(['iv' => $ivB, 'value' => $value, 'mac' => $mac, 'tag' => $tagB], JSON_UNESCAPED_SLASHES));
}

$k256 = str_repeat("\x01\x02\x03\x04\x05\x06\x07\x08", 4);
$k128 = substr($k256, 0, 16);
$kOld = str_repeat("\xa0\xb1\xc2\xd3", 8);
$ak256 = 'base64:' . base64_encode($k256);
$ak128 = 'base64:' . base64_encode($k128);
$akOld = 'base64:' . base64_encode($kOld);

$plains = [
    'simple' => 'postgres://app:hunter2@db:5432/app',
    'utf8' => "pa\u{00df}w\u{00f6}rd-\u{20ac}-\u{1F511}",
    'multiline' => "line1\nline2 \"quoted\" ; s:3:\"x\";\n",
    'empty' => '',
    'long' => str_repeat('0123456789abcdef', 300),
];

$out = [];
foreach ($plains as $n => $p) {
    $ser = serialize($p);
    $out[] = ['name' => "cbc256-serialized-$n", 'key' => $ak256, 'prev' => [], 'payload' => enc($ser, 'aes-256-cbc', $k256), 'plainB64' => base64_encode($p), 'form' => 'serialized', 'cipher' => 'aes-256-cbc'];
    $out[] = ['name' => "cbc256-string-$n", 'key' => $ak256, 'prev' => [], 'payload' => enc($p, 'aes-256-cbc', $k256), 'plainB64' => base64_encode($p), 'form' => 'string', 'cipher' => 'aes-256-cbc'];
}
$p = $plains['simple'];
$out[] = ['name' => 'cbc128-serialized', 'key' => $ak128, 'prev' => [], 'payload' => enc(serialize($p), 'aes-128-cbc', $k128), 'plainB64' => base64_encode($p), 'form' => 'serialized', 'cipher' => 'aes-128-cbc'];
$out[] = ['name' => 'gcm256-string', 'key' => $ak256, 'prev' => [], 'payload' => enc($p, 'aes-256-gcm', $k256), 'plainB64' => base64_encode($p), 'form' => 'string', 'cipher' => 'aes-256-gcm'];
$out[] = ['name' => 'gcm256-serialized', 'key' => $ak256, 'prev' => [], 'payload' => enc(serialize($p), 'aes-256-gcm', $k256), 'plainB64' => base64_encode($p), 'form' => 'serialized', 'cipher' => 'aes-256-gcm'];
$out[] = ['name' => 'gcm128-string', 'key' => $ak128, 'prev' => [], 'payload' => enc($p, 'aes-128-gcm', $k128), 'plainB64' => base64_encode($p), 'form' => 'string', 'cipher' => 'aes-128-gcm'];
// Encrypted under the OLD key; the current key is a different one (APP_PREVIOUS_KEYS case).
$out[] = ['name' => 'previous-key', 'key' => $ak256, 'prev' => [$akOld], 'payload' => enc($p, 'aes-256-cbc', $kOld), 'plainB64' => base64_encode($p), 'form' => 'string', 'cipher' => 'aes-256-cbc', 'viaPrev' => true];
// Unsupported serialized shapes (never unserialized).
foreach (['array' => ['a', 'b'], 'int' => 42, 'bool' => true, 'null' => null, 'float' => 1.5] as $n => $v) {
    $out[] = ['name' => "unsupported-$n", 'key' => $ak256, 'prev' => [], 'payload' => enc(serialize($v), 'aes-256-cbc', $k256), 'form' => 'serialized', 'cipher' => 'aes-256-cbc', 'code' => 'unsupported_serialization'];
}
$out[] = ['name' => 'object', 'key' => $ak256, 'prev' => [], 'payload' => enc(serialize(new ArrayObject([1])), 'aes-256-cbc', $k256), 'form' => 'serialized', 'cipher' => 'aes-256-cbc', 'code' => 'unsupported_serialization'];
// Tampered / wrong key / truncated.
$good = enc($p, 'aes-256-cbc', $k256);
$j = json_decode(base64_decode($good), true);
$m = $j; $m['mac'] = str_repeat('0', 64);
$out[] = ['name' => 'bad-mac', 'key' => $ak256, 'prev' => [], 'payload' => base64_encode(json_encode($m)), 'form' => 'string', 'cipher' => 'aes-256-cbc', 'code' => 'bad_mac'];
$out[] = ['name' => 'wrong-key', 'key' => $akOld, 'prev' => [], 'payload' => $good, 'form' => 'string', 'cipher' => 'aes-256-cbc', 'code' => 'bad_mac'];
$g = enc($p, 'aes-256-gcm', $k256);
$jg = json_decode(base64_decode($g), true);
$jg['tag'] = base64_encode(str_repeat("\x00", 16));
$out[] = ['name' => 'gcm-bad-tag', 'key' => $ak256, 'prev' => [], 'payload' => base64_encode(json_encode($jg)), 'form' => 'string', 'cipher' => 'aes-256-gcm', 'code' => 'bad_mac'];
// 16-byte iv with a valid MAC but a ciphertext that is not block aligned (re-MAC'd so the MAC passes): bad padding / length.
$v2 = $j; $raw = base64_decode($j['value']); $v2['value'] = base64_encode(substr($raw, 0, 7)); $v2['mac'] = hash_hmac('sha256', $v2['iv'] . $v2['value'], $k256);
$out[] = ['name' => 'bad-length-valid-mac', 'key' => $ak256, 'prev' => [], 'payload' => base64_encode(json_encode($v2)), 'form' => 'string', 'cipher' => 'aes-256-cbc', 'code' => 'bad_payload'];
// Garbage in the padding block (MAC is over the ciphertext, so flip the last block and re-MAC): padding check must fail.
$v3 = $j; $raw = base64_decode($j['value']); $raw[strlen($raw) - 1] = chr(ord($raw[strlen($raw) - 1]) ^ 0xff); $v3['value'] = base64_encode($raw); $v3['mac'] = hash_hmac('sha256', $v3['iv'] . $v3['value'], $k256);
$out[] = ['name' => 'bad-padding-valid-mac', 'key' => $ak256, 'prev' => [], 'payload' => base64_encode(json_encode($v3)), 'form' => 'string', 'cipher' => 'aes-256-cbc', 'code' => 'bad_payload'];
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
