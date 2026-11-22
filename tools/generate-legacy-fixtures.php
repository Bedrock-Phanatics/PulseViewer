<?php

declare(strict_types=1);

use quark\pulse\internal\PulseContext;
use quark\pulse\internal\PulseNetwork;
use quark\pulse\PulseReport;

$root = $argv[1] ?? throw new InvalidArgumentException("Pass the Quark checkout path (main, Pulse v4)");
$directory = __DIR__ . "/../tests/fixtures";
foreach($argv as $argument){
    if(str_starts_with($argument, "--out=")){ $directory = substr($argument, 6); }
}
// re-derives the pre-v4 fixtures by downgrading v4 encoder output
// committed files are the originals, compare decoded json instead of bytes
require $root . "/vendor/autoload.php";
foreach(["src/pulse/PulseZone.php", "src/pulse/internal/PulseNode.php", "src/pulse/internal/PulseNetwork.php", "src/pulse/internal/PulseResources.php", "src/pulse/internal/PulseWorkers.php", "src/pulse/internal/PulseContext.php", "src/pulse/PulseReport.php"] as $file){
    require_once $root . "/" . $file;
}

// downgrades a v4 report, quark's decoder validates the result
function legacy(PulseReport $report, int $version = 1) : string{
    $data = $report->getData();
    $data["version"] = $version;
    foreach($data["threads"] as &$thread){
        unset($thread["zone_owners"], $thread["async"]);
        if($version < 3) unset($thread["resources"], $thread["slow_tick_count"]);
        elseif(isset($thread["resources"])){
            foreach($thread["resources"]["samples"] as &$sample){ $sample = array_slice($sample, 0, 6); }
            unset($sample);
        }
        if($version === 1) unset($thread["network"]);
        elseif(isset($thread["network"])) unset($thread["network"]["transports"]);
    }
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
if(!is_dir($directory)) mkdir($directory, 0777, true);
file_put_contents($directory . "/quark-v1.qpulse", legacy($report));
$resourceMain = $main->capture();
$resourceMain["ended_ns"] = $resourceMain["started_ns"] + 4000000000;
$resourceMain["network"] = PulseNetwork::emptyCapture(4000000000);
$resourceMain["resources"] = ["samples_dropped" => 0, "samples" => [
    [0, 0, null, null, 64 * 1048576, 128 * 1048576, null, null],
    [1000000000, 1000000000, 800000000, 200000000, 80 * 1048576, 128 * 1048576, null, null],
    [2000000000, 1000000000, 1800000000, 200000000, 96 * 1048576, 128 * 1048576, null, null],
    [3000000000, 1000000000, null, null, 72 * 1048576, 128 * 1048576, null, null],
    [4000000000, 1000000000, 400000000, 100000000, 76 * 1048576, 128 * 1048576, null, null]
]];
file_put_contents($directory . "/resources-v3.qpulse", legacy(PulseReport::create([$resourceMain, $worker->capture()], $metadata), 3));
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
file_put_contents($directory . "/network-v2.qpulse", legacy(PulseReport::create([$networkContext->capture()], $metadata), 2));
echo "Regenerated four legacy fixtures plus resources-v3 into $directory\n";
