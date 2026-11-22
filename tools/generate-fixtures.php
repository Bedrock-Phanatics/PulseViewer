<?php

declare(strict_types=1);

// v4 fixtures and the public sample, written by quark's own encoder
// usage: php tools/generate-fixtures.php <quark at main> [--out=<dir>]
// pre-v4 fixtures live in generate-legacy-fixtures.php

use quark\pulse\internal\PulseContext;
use quark\pulse\internal\PulseNetwork;
use quark\pulse\PulseReport;

$root = $argv[1] ?? throw new InvalidArgumentException("Pass the Quark checkout path (main, Pulse v4)");
$directory = __DIR__ . "/../tests/fixtures";
$public = __DIR__ . "/../public";
foreach($argv as $argument){
    if(str_starts_with($argument, "--out=")){ $directory = $public = substr($argument, 6); }
}
require $root . "/vendor/autoload.php";
foreach(["src/pulse/PulseZone.php", "src/pulse/internal/PulseNode.php", "src/pulse/internal/PulseNetwork.php", "src/pulse/internal/PulseResources.php", "src/pulse/internal/PulseWorkers.php", "src/pulse/internal/PulseContext.php", "src/pulse/PulseReport.php"] as $file){
    require_once $root . "/" . $file;
}
if(PulseReport::FORMAT_VERSION !== 4){ throw new RuntimeException("This checkout does not encode Pulse v4"); }
if(!is_dir($directory)) mkdir($directory, 0777, true);
if(!is_dir($public)) mkdir($public, 0777, true);

const MIB = 1048576;
$metadata = [
    "quark_version" => "6.0.0", "php_version" => "8.4.14", "platform" => "fixture",
    "cpu_threads" => 4, "created_unix_ms" => 1791504000000,
    "plugins" => [["name" => "SkyWars", "version" => "1.0"], ["name" => "Economy", "version" => "2.1"]], "worlds" => ["Lobby"]
];

// full-v4: every v4 field, deterministic. only the resource samples are replaced with fixed values
$start = 9007199254740993; // beyond Number.MAX_SAFE_INTEGER
$main = new PulseContext(maxTicks: 8);
$serverTick = $main->zone("server.tick")->getId();
$world = $main->zone("world.tick")->getId();
$skyTask = $main->zone("plugin.SkyWars", "SkyWars")->getId();
$skyMove = $main->zone("event.SkyWars.PlayerMoveEvent", "SkyWars")->getId();
$economyEvent = $main->zone("event.Economy.BalanceEvent", "Economy")->getId();
$economyTask = $main->zone("plugin.Economy", "Economy")->getId();
$main->start("main", $start, spikeThresholdNs: 50000000);
$now = $start;
foreach([20000000, 60000000, 25000000] as $duration){
    $main->beginTick($now);
    $scope = $main->begin($serverTick, $now);
    $w = $main->begin($world, $now);
    $main->end($world, $w, $now + 2000000);
    $sky = $main->begin($skyTask, $now + 2000000);
    $move = $main->begin($skyMove, $now + 3000000);
    $balance = $main->begin($economyEvent, $now + 4000000);
    $main->end($economyEvent, $balance, $now + 6000000);
    $again = $main->begin($skyMove, $now + 7000000);
    $main->end($skyMove, $again, $now + 9000000);
    $main->end($skyMove, $move, $now + 10000000);
    $main->end($skyTask, $sky, $now + 12000000);
    $eco = $main->begin($economyTask, $now + 12000000);
    $main->end($economyTask, $eco, $now + 14000000);
    $main->end($serverTick, $scope, $now + $duration);
    $main->endTick($now + $duration);
    $now += $duration + 50000000;
}
// 12 submitted, 11 collected, pickup 80 ms every third result and 10 ms otherwise
$workers = $main->workers() ?? throw new RuntimeException("Pulse workers are unavailable");
for($i = 1; $i <= 12; ++$i){ $workers->submitted(min($i, 5)); }
for($i = 1; $i <= 11; ++$i){
    $queued = $start + $i * 100000000;
    $finished = $queued + 60000000;
    $workers->collected($queued, $finished, $finished + ($i % 3 === 0 ? 80000000 : 10000000));
}
$network = $main->network();
$network->session(1000, "in_game", $start + 100000000);
for($i = 0; $i < 4; ++$i){
    $window = $network->window(1, $start + $i * 1000000000);
    $network->count($window, PulseNetwork::BATCHES, 3);
    $network->count($window, PulseNetwork::PACKETS, 30);
    $network->count($window, PulseNetwork::RECEIVED_BYTES, 1200);
    $network->count($window, PulseNetwork::DECODED, 30);
}
$network->transportTotals("bedwire", [
    "bytes_sent" => 1000, "bytes_received" => 2000, "batches_sent" => 10, "packets_received" => 20, "packets_rejected" => 1,
    "unreliable_dropped" => 0, "receive_pauses" => 0, "event_stalls" => 0, "overload_disconnects" => 0, "future_widget_count" => 5,
    "sessions" => 1, "command_queue_bytes" => 100, "event_queue_bytes" => 50
]);
$network->transportTotals("bedwire", [
    "bytes_sent" => 5243880, "bytes_received" => 3146000, "batches_sent" => 1510, "packets_received" => 40020, "packets_rejected" => 13,
    "unreliable_dropped" => 4, "receive_pauses" => 3, "event_stalls" => 2, "overload_disconnects" => 1, "future_widget_count" => 12,
    "sessions" => 24, "command_queue_bytes" => 262144, "event_queue_bytes" => 65536
]);
$network->transportBytes("raklib", 1500000, 750000);
$main->stop($start + 4000000000);
$fullMain = $main->capture();
$fullMain["resources"] = ["samples_dropped" => 0, "samples" => [
    [0, 0, null, null, 64 * MIB, 128 * MIB, 512 * MIB, 600 * MIB],
    [1000000000, 1000000000, 800000000, 200000000, 80 * MIB, 128 * MIB, 520 * MIB, 600 * MIB],
    [2000000000, 1000000000, 1800000000, 200000000, 96 * MIB, 128 * MIB, 540 * MIB, 620 * MIB],
    [3000000000, 1000000000, null, null, 72 * MIB, 128 * MIB, null, null],
    [4000000000, 1000000000, 400000000, 100000000, 76 * MIB, 128 * MIB, 530 * MIB, 620 * MIB]
]];
// worker#1 four tasks, worker#2 idle, worker#3 saturated (7 x 500 ms of 4 s)
$worker = new PulseContext();
$task = $worker->zone("async.chunk.generate")->getId();
$worker->start("worker#1", $start);
$scope = $worker->begin($task, $start + 10);
$worker->end($task, $scope, $start + 20);
$ran = $worker->workers() ?? throw new RuntimeException("Pulse workers are unavailable");
foreach([[2, 10, 12], [40, 20, 24], [0, 30, 20], [10, 40, 16]] as $index => [$wait, $run, $heap]){
    $queued = $start + 100000000 + $index * 1000000000;
    $ran->ran($queued, $queued + $wait * 1000000, $queued + ($wait + $run) * 1000000, $heap * MIB);
}
$worker->stop($start + 4000000000);
$idle = new PulseContext();
$idle->start("worker#2", $start);
$idle->stop($start + 4000000000);
$busy = new PulseContext();
$busy->start("worker#3", $start);
$busyWorkers = $busy->workers() ?? throw new RuntimeException("Pulse workers are unavailable");
for($i = 0; $i < 7; ++$i){
    $queued = $start + 100000000 + $i * 500000000;
    $busyWorkers->ran($queued, $queued + 200000000, $queued + 700000000, (30 + $i) * MIB);
}
$busy->stop($start + 4000000000);
file_put_contents($directory . "/full-v4.qpulse", PulseReport::create([$fullMain, $worker->capture(), $idle->capture(), $busy->capture()], $metadata)->encode(true));

// real-v4: unmodified capture, real clock and real getrusage and /proc sampling
$clock = static fn() : int => (int) hrtime(true);
$real = new PulseContext(maxTicks: 64);
$realServer = $real->zone("server.tick")->getId();
$realPlugin = $real->zone("plugin.RealPlugin", "RealPlugin")->getId();
$realStart = $clock();
$real->start("main", $realStart, spikeThresholdNs: 40000000);
$realWorkers = $real->workers() ?? throw new RuntimeException("Pulse workers are unavailable");
$padding = [];
for($i = 0; $i < 48; ++$i){
    $tickStart = $clock();
    $real->beginTick($tickStart);
    $scope = $real->begin($realServer, $clock());
    $pluginScope = $real->begin($realPlugin, $clock());
    $padding[] = str_repeat("x", 65536); // grow the heap a little so memory deltas are real
    usleep(6000 + ($i % 5) * 1000 + ($i === 20 ? 45000 : 0));
    $real->end($realPlugin, $pluginScope, $clock());
    usleep(2000);
    $real->end($realServer, $scope, $clock());
    $realWorkers->submitted(1 + $i % 3);
    $realWorkers->collected($tickStart, $clock(), $clock());
    $real->endTick($clock());
    usleep(max(0, 50000 - intdiv($clock() - $tickStart, 1000)));
}
$real->network()->transportTotals("bedwire", ["bytes_sent" => 100, "bytes_received" => 100, "sessions" => 0]);
$real->network()->transportTotals("bedwire", ["bytes_sent" => 4196, "bytes_received" => 2148, "sessions" => 2]);
$real->stop($clock());
$realWorker = new PulseContext();
$realWorkerTask = $realWorker->zone("async.task")->getId();
$workerStart = $clock();
$realWorker->start("worker#1", $workerStart);
$realRan = $realWorker->workers() ?? throw new RuntimeException("Pulse workers are unavailable");
for($i = 0; $i < 5; ++$i){
    $queued = $clock();
    usleep(1000);
    $started = $clock();
    $scope = $realWorker->begin($realWorkerTask, $started);
    usleep(3000);
    $finished = $clock();
    $realWorker->end($realWorkerTask, $scope, $finished);
    $realRan->ran($queued, $started, $finished, memory_get_usage());
}
$realWorker->stop($clock());
file_put_contents($directory . "/real-v4.qpulse", PulseReport::create([$real->capture(), $realWorker->capture()], $metadata)->encode(true));

// incomplete-v4: snapshot while recording, scopes still open
$live = new PulseContext();
$liveServer = $live->zone("server.tick")->getId();
$livePlugin = $live->zone("plugin.SkyWars", "SkyWars")->getId();
$liveStart = $clock();
$live->start("main", $liveStart);
for($i = 0; $i < 3; ++$i){
    $t = $clock();
    $live->beginTick($t);
    $scope = $live->begin($liveServer, $t);
    $inner = $live->begin($livePlugin, $clock());
    usleep(2000);
    $live->end($livePlugin, $inner, $clock());
    $live->end($liveServer, $scope, $clock());
    $live->endTick($clock());
}
$live->workers()?->submitted(2);
$live->beginTick($clock());
$live->begin($liveServer, $clock());
$live->begin($livePlugin, $clock());
$liveWorker = new PulseContext();
$liveWorker->start("worker#1", $liveStart);
file_put_contents($directory . "/incomplete-v4.qpulse", PulseReport::create([$live->capture(), $liveWorker->capture()], $metadata)->encode(true));

// minimal-v4: no owners, no async work, no transports, no RSS, short final cpu interval
$minimal = new PulseContext(maxTicks: 4);
$minimalServer = $minimal->zone("server.tick")->getId();
$minimal->start("main", 5000000000);
for($i = 0; $i < 3; ++$i){
    $t = 5000000000 + $i * 100000000;
    $minimal->beginTick($t);
    $scope = $minimal->begin($minimalServer, $t);
    $minimal->end($minimalServer, $scope, $t + 20000000);
    $minimal->endTick($t + 20000000);
}
$minimal->stop(5000000000 + 2400000000);
$minimalMain = $minimal->capture();
$minimalMain["resources"] = ["samples_dropped" => 0, "samples" => [
    [0, 0, null, null, 32 * MIB, 64 * MIB, null, null],
    [1000000000, 1000000000, 300000000, 100000000, 33 * MIB, 64 * MIB, null, null],
    [2000000000, 1000000000, 500000000, 100000000, 34 * MIB, 64 * MIB, null, null],
    [2400000000, 400000000, null, null, 34 * MIB, 64 * MIB, null, null]
]];
$minimalWorker = new PulseContext();
$minimalWorker->start("worker#1", 5000000000);
$minimalWorker->stop(5000000000 + 2400000000);
file_put_contents($directory . "/minimal-v4.qpulse", PulseReport::create([$minimalMain, $minimalWorker->capture()], $metadata)->encode(true));

// idle-v4: a thread that never recorded has null resources and async, empty-v4 has no threads
file_put_contents($directory . "/idle-v4.qpulse", PulseReport::create([(new PulseContext())->capture()], $metadata)->encode(true));
file_put_contents($directory . "/empty-v4.qpulse", PulseReport::create([], $metadata)->encode(true));

// public demo sample
$sample = new PulseContext(maxTicks: 600);
$names = ["server.tick", "world.tick", "world.entity.tick", "world.block.tick", "plugin.SkyWars", "event.SkyWars.PlayerMoveEvent", "network.process", "network.packet.batch", "scheduler.heartbeat"];
$zones = array_map(fn(string $name) => $sample->zone($name, str_contains($name, "SkyWars") ? "SkyWars" : null)->getId(), $names);
$now = 1000000000;
$sample->start("main", $now, spikeThresholdNs: 50000000, maxSpikes: 32);
$sampleNetwork = $sample->network();
$sampleNetwork->session(1000, "in_game", $now);
$outliers = [54 => 92000000, 180 => 128000000, 315 => 74000000, 480 => 182000000, 602 => 103000000, 710 => 87000000, 784 => 119000000];
for($tick = 1; $tick <= 800; ++$tick){
    $duration = $outliers[$tick] ?? (18000000 + (($tick * 7919) % 9000000) + (int) (sin($tick / 24) * 4000000));
    $sample->beginTick($now);
    $window = $sampleNetwork->window(1, $now);
    $packets = 12 + $tick % 7;
    $failed = $tick % 180 === 0 ? 1 : 0;
    $sampleNetwork->count($window, PulseNetwork::BATCHES);
    $sampleNetwork->count($window, PulseNetwork::PACKETS, $packets);
    $sampleNetwork->count($window, PulseNetwork::RECEIVED_BYTES, $packets * 40);
    $sampleNetwork->count($window, PulseNetwork::DECOMPRESSED_BYTES, $packets * 80);
    $sampleNetwork->count($window, PulseNetwork::DECODED, $packets - $failed);
    $sampleNetwork->count($window, PulseNetwork::DECODE_FAILED, $failed);
    if($tick % 4 === 0) $sampleNetwork->count($window, PulseNetwork::PLUGIN_CANCELLED);
    if($failed) $sampleNetwork->event(1, 193, "in_game", "packet.malformed", "reject_batch", tick: $tick, now: $now);

    $rootScope = $sample->begin($zones[0], $now);
    $worldDuration = intdiv($duration * 28, 100);
    $worldScope = $sample->begin($zones[1], $now);
    $entityScope = $sample->begin($zones[2], $now);
    $sample->end($zones[2], $entityScope, $now + intdiv($worldDuration * 3, 4));
    $blockScope = $sample->begin($zones[3], $now + intdiv($worldDuration * 3, 4));
    $sample->end($zones[3], $blockScope, $now + $worldDuration);
    $sample->end($zones[1], $worldScope, $now + $worldDuration);
    $cursor = $now + $worldDuration;
    $pluginDuration = intdiv($duration * 40, 100);
    $pluginScope = $sample->begin($zones[4], $cursor);
    $eventScope = $sample->begin($zones[5], $cursor);
    $sample->end($zones[5], $eventScope, $cursor + intdiv($pluginDuration * 9, 10));
    $sample->end($zones[4], $pluginScope, $cursor + $pluginDuration);
    $cursor += $pluginDuration;
    $networkDuration = intdiv($duration * 18, 100);
    $networkScope = $sample->begin($zones[6], $cursor);
    $packetScope = $sample->begin($zones[7], $cursor);
    $sample->end($zones[7], $packetScope, $cursor + intdiv($networkDuration * 4, 5));
    $sample->end($zones[6], $networkScope, $cursor + $networkDuration);
    $cursor += $networkDuration;
    $schedulerScope = $sample->begin($zones[8], $cursor);
    $sample->end($zones[8], $schedulerScope, $cursor + intdiv($duration * 7, 100));
    $sample->end($zones[0], $rootScope, $now + $duration);
    $sample->endTick($now + $duration);
    $now += max(50000000, $duration + 5000000);
}
// illustrative async and transport readings, not host measurements
$sampleAsync = $sample->workers() ?? throw new RuntimeException("Pulse workers are unavailable");
for($i = 0; $i < 200; ++$i){ $sampleAsync->submitted(1 + $i % 4); }
for($i = 0; $i < 198; ++$i){
    $queued = 1000000000 + $i * 200000000;
    $finished = $queued + 24000000;
    $sampleAsync->collected($queued, $finished, $finished + ($i % 25 === 0 ? 65000000 : 12000000));
}
$sampleTransport = $sample->network();
$sampleTransport->transportTotals("bedwire", ["bytes_sent" => 0, "bytes_received" => 0, "batches_sent" => 0, "packets_received" => 0, "packets_rejected" => 0, "unreliable_dropped" => 0, "receive_pauses" => 0, "sessions" => 0, "command_queue_bytes" => 0]);
$sampleTransport->transportTotals("bedwire", ["bytes_sent" => 18350080, "bytes_received" => 2621440, "batches_sent" => 6400, "packets_received" => 12800, "packets_rejected" => 5, "unreliable_dropped" => 0, "receive_pauses" => 2, "sessions" => 1, "command_queue_bytes" => 131072]);
$sample->stop($now);
$sampleWorker = new PulseContext();
$generate = $sampleWorker->zone("async.chunk.generate")->getId();
$terrain = $sampleWorker->zone("world.terrain.populate")->getId();
$sampleWorker->start("worker#1", 1000000000);
$sampleRan = $sampleWorker->workers() ?? throw new RuntimeException("Pulse workers are unavailable");
for($i = 0; $i < 200; ++$i){
    $start = 1000000000 + $i * 200000000;
    $scope = $sampleWorker->begin($generate, $start);
    $child = $sampleWorker->begin($terrain, $start);
    $sampleWorker->end($terrain, $child, $start + 16000000);
    $sampleWorker->end($generate, $scope, $start + 21000000);
    $sampleRan->ran($start - 3000000, $start, $start + 21000000, (8 + $i % 8) * 1048576);
}
$sampleWorker->stop($now);
$sampleMetadata = $metadata;
$sampleMetadata["platform"] = "Linux x86_64";
$sampleMetadata["worlds"] = ["Lobby", "SkyWars-01"];
$sampleMain = $sample->capture();
// The public sample illustrates resource variation; these are not host measurements.
$sampleMain["resources"] = ["samples_dropped" => 0, "samples" => [[0, 0, null, null, 64 * 1048576, 128 * 1048576, 410 * 1048576, 410 * 1048576]]];
$length = $sampleMain["ended_ns"] - $sampleMain["started_ns"];
$previous = 0;
for($offset = 1000000000; $previous < $length; $offset += 1000000000){
    $end = min($offset, $length);
    $interval = $end - $previous;
    $spike = intdiv($offset, 1000000000) % 9 === 0;
    $sampleMain["resources"]["samples"][] = [$end, $interval, $interval < 1000000000 ? null : intdiv($interval * ($spike ? 150 : 45), 100), $interval < 1000000000 ? null : intdiv($interval, 10), ($spike ? 96 : 72) * 1048576, 128 * 1048576, (415 + intdiv($offset, 1000000000) * 2) * 1048576, (415 + intdiv($offset, 1000000000) * 2) * 1048576];
    $previous = $end;
}
file_put_contents($public . "/sample.qpulse", PulseReport::create([$sampleMain, $sampleWorker->capture()], $sampleMetadata)->encode(true));
echo "Generated the Pulse v4 fixtures and the sample with Quark's encoder\n";
