<?php

declare(strict_types=1);

use quark\pulse\internal\PulseContext;
use quark\pulse\internal\PulseNetwork;
use quark\pulse\PulseReport;

$root = $argv[1] ?? throw new InvalidArgumentException("Pass the Quark checkout path");
require $root . "/vendor/autoload.php";
foreach(["src/pulse/PulseZone.php", "src/pulse/internal/PulseNode.php", "src/pulse/internal/PulseNetwork.php", "src/pulse/internal/PulseContext.php", "src/pulse/PulseReport.php"] as $file){
    require_once $root . "/" . $file;
}

function legacy(PulseReport $report) : string{
    $data = $report->getData();
    $data["version"] = 1;
    foreach($data["threads"] as &$thread) unset($thread["network"]);
    unset($thread);
    return PulseReport::decode(json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE))->encode(true);
}

$metadata = [
    "quark_version" => "6.0.0", "php_version" => "8.4.14", "platform" => "fixture",
    "cpu_threads" => 4, "created_unix_ms" => 1791504000000,
    "plugins" => [["name" => "SkyWars", "version" => "1.0"]], "worlds" => ["Lobby"]
];
$main = new PulseContext(maxTicks: 2);
$rootZone = $main->zone("server.tick")->getId();
$world = $main->zone("world.tick")->getId();
$plugin = $main->zone("plugin.SkyWars")->getId();
$event = $main->zone("event.SkyWars.PlayerMoveEvent")->getId();
$now = 9007199254740993;
$main->start("main", $now, spikeThresholdNs: 30000000);
foreach([10000000, 80000000, 20000000, 60000000] as $duration){
    $main->beginTick($now);
    $scope = $main->begin($rootZone, $now);
    $worldScope = $main->begin($world, $now);
    $main->end($world, $worldScope, $now + intdiv($duration, 4));
    $pluginScope = $main->begin($plugin, $now + intdiv($duration, 4));
    $eventScope = $main->begin($event, $now + intdiv($duration, 4));
    $main->end($event, $eventScope, $now + intdiv($duration * 3, 4));
    $main->end($plugin, $pluginScope, $now + intdiv($duration * 3, 4));
    $main->end($rootZone, $scope, $now + $duration);
    $main->endTick($now + $duration);
    $now += $duration + 50000000;
}
$main->stop($now);
$worker = new PulseContext();
$task = $worker->zone("async.chunk.generate")->getId();
$worker->start("worker#1", 200);
$scope = $worker->begin($task, 200);
$worker->end($task, $scope, 210);
$worker->stop(210);
$report = PulseReport::create([$main->capture(), $worker->capture()], $metadata);
$directory = __DIR__ . "/../tests/fixtures";
if(!is_dir($directory)) mkdir($directory, 0777, true);
file_put_contents($directory . "/quark-v1.qpulse", legacy($report));
file_put_contents($directory . "/empty-v1.qpulse", legacy(PulseReport::create([], $metadata)));
$live = new PulseContext();
$zone = $live->zone("recursive")->getId();
$live->start("main", 100);
$live->beginTick(100);
$live->begin($zone, 100);
$child = $live->begin($zone, 110);
$live->end($zone, $child, 120);
file_put_contents($directory . "/live-v1.qpulse", legacy(PulseReport::create([$live->capture()], $metadata)));
$networkContext = new PulseContext();
$networkContext->start("network-main", 1000000000);
$network = $networkContext->network();
$network->session(1000, "in_game", 1000000000);
for($i = 0; $i < 8; ++$i){
    $now = 1000000000 + $i * 1000000000;
    if($i === 2) $network->session(null, "login", $now);
    $window = $network->window(1, $now);
    $packets = $i === 3 ? 320 : 12 + $i;
    $failed = $i === 3 ? 12 : 0;
    $network->count($window, PulseNetwork::BATCHES, 2);
    $network->count($window, PulseNetwork::PACKETS, $packets);
    $network->count($window, PulseNetwork::RECEIVED_BYTES, $packets * 40);
    $network->count($window, PulseNetwork::DECOMPRESSED_BYTES, $packets * 80);
    $network->count($window, PulseNetwork::DECODED, $packets - $failed);
    $network->count($window, PulseNetwork::DECODE_FAILED, $failed);
    $network->count($window, PulseNetwork::PLUGIN_CANCELLED, 2);
    if($i === 2 || $i === 3){
        $second = $network->window(2, $now);
        $network->count($second, PulseNetwork::BATCHES);
        $network->count($second, PulseNetwork::PACKETS, 4);
        $network->count($second, PulseNetwork::DECODED, 3);
        $network->count($second, PulseNetwork::DECODE_FAILED);
    }
    if($i === 2) $network->event(2, 193, "login", "packet.malformed", "reject_batch", now: $now + 100000000);
    if($i === 3){
        $network->event(2, 193, "login", "rate.packet", "reject_batch", observed: 1, limit: -1, now: $now + 100000000);
        $network->event(2, 193, "login", "packet.bad_packet_disconnect", "disconnect", now: $now + 100000001);
        $network->updateSession(2, 1000, "closed", $now + 100000001);
    }
    if($i === 7) $network->event(1, null, "in_game", "decompression.limit", "reject_batch", observed: 8388609, limit: 8388608, now: $now + 100000000);
}
$networkContext->stop(8750000000);
file_put_contents($directory . "/network-v2.qpulse", PulseReport::create([$networkContext->capture()], $metadata)->encode(true));
$sample = new PulseContext(maxTicks: 600);
$names = ["server.tick", "world.tick", "world.entity.tick", "world.block.tick", "plugin.SkyWars", "event.SkyWars.PlayerMoveEvent", "network.process", "network.packet.batch", "scheduler.heartbeat"];
$zones = array_map(fn(string $name) => $sample->zone($name)->getId(), $names);
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
$sample->stop($now);
$sampleWorker = new PulseContext();
$generate = $sampleWorker->zone("async.chunk.generate")->getId();
$terrain = $sampleWorker->zone("world.terrain.populate")->getId();
$sampleWorker->start("worker#1", 1000000000);
for($i = 0; $i < 200; ++$i){
    $start = 1000000000 + $i * 200000000;
    $scope = $sampleWorker->begin($generate, $start);
    $child = $sampleWorker->begin($terrain, $start);
    $sampleWorker->end($terrain, $child, $start + 16000000);
    $sampleWorker->end($generate, $scope, $start + 21000000);
}
$sampleWorker->stop($now);
$sampleMetadata = $metadata;
$sampleMetadata["platform"] = "Linux x86_64";
$sampleMetadata["worlds"] = ["Lobby", "SkyWars-01"];
$public = __DIR__ . "/../public";
if(!is_dir($public)) mkdir($public, 0777, true);
file_put_contents($public . "/sample.qpulse", PulseReport::create([$sample->capture(), $sampleWorker->capture()], $sampleMetadata)->encode(true));
echo "Generated four fixtures and the sample with Quark's encoder\n";
