<?php

declare(strict_types=1);

use quark\pulse\internal\PulseContext;
use quark\pulse\PulseReport;

$root = $argv[1] ?? throw new InvalidArgumentException("Pass the Quark checkout path");
require $root . "/vendor/autoload.php";
foreach(["src/pulse/PulseZone.php", "src/pulse/internal/PulseNode.php", "src/pulse/internal/PulseContext.php", "src/pulse/PulseReport.php"] as $file){
    require_once $root . "/" . $file;
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
file_put_contents($directory . "/quark-v1.qpulse", $report->encode(true));
file_put_contents($directory . "/empty-v1.qpulse", PulseReport::create([], $metadata)->encode(true));
$live = new PulseContext();
$zone = $live->zone("recursive")->getId();
$live->start("main", 100);
$live->beginTick(100);
$live->begin($zone, 100);
$child = $live->begin($zone, 110);
$live->end($zone, $child, 120);
file_put_contents($directory . "/live-v1.qpulse", PulseReport::create([$live->capture()], $metadata)->encode(true));
$sample = new PulseContext(maxTicks: 600);
$names = ["server.tick", "world.tick", "world.entity.tick", "world.block.tick", "plugin.SkyWars", "event.SkyWars.PlayerMoveEvent", "network.process", "network.packet.batch", "scheduler.heartbeat"];
$zones = array_map(fn(string $name) => $sample->zone($name)->getId(), $names);
$now = 1000000000;
$sample->start("main", $now, spikeThresholdNs: 50000000, maxSpikes: 32);
$outliers = [54 => 92000000, 180 => 128000000, 315 => 74000000, 480 => 182000000, 602 => 103000000, 710 => 87000000, 784 => 119000000];
for($tick = 1; $tick <= 800; ++$tick){
    $duration = $outliers[$tick] ?? (18000000 + (($tick * 7919) % 9000000) + (int) (sin($tick / 24) * 4000000));
    $sample->beginTick($now);
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
echo "Generated three fixtures and the sample with Quark's encoder\n";
