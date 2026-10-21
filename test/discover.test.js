'use strict';
// adb_devices discover=true: mDNS output, subnet choice, the TCP probe and the
// report. No real network beyond 127.0.0.1, no real adb.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const D = require('../src/discover.js');
const S = require('../src/server.js');
const { useFakeAdb } = require('./helpers.js');

// The format of adb's own client: a header, then "<instance>\t<service>\t<ip>:<port>".
const MDNS = 'List of discovered mdns services\n' +
  'adb-R5CX00000AB-AbCdEf\t_adb-tls-connect._tcp\t192.0.2.21:38123\n' +
  'adb-R5CX00000AB-AbCdEf\t_adb-tls-pairing._tcp\t192.0.2.21:41234\n' +
  'Android_TV_0001\t_adb._tcp\t192.0.2.30:5555\n';

test('mDNS: adb\'s format, trailing dots, spaces instead of tabs, junk and empty output', () => {
  assert.deepEqual(D.parseMdnsServices(MDNS), [
    { instance: 'adb-R5CX00000AB-AbCdEf', service: '_adb-tls-connect._tcp', host: '192.0.2.21', port: 38123, kind: 'connect' },
    { instance: 'adb-R5CX00000AB-AbCdEf', service: '_adb-tls-pairing._tcp', host: '192.0.2.21', port: 41234, kind: 'pairing' },
    { instance: 'Android_TV_0001', service: '_adb._tcp', host: '192.0.2.30', port: 5555, kind: 'adb' },
  ]);
  assert.deepEqual(D.parseMdnsServices('adb-X    _adb-tls-connect._tcp.    192.0.2.22:40001\r\n'),
    [{ instance: 'adb-X', service: '_adb-tls-connect._tcp', host: '192.0.2.22', port: 40001, kind: 'connect' }]);
  assert.deepEqual(D.parseMdnsServices('List of discovered mdns services\n'), []);
  assert.deepEqual(D.parseMdnsServices('ERROR: mdns discovery disabled\n'), []);
  assert.deepEqual(D.parseMdnsServices(''), []);
});

const IFACES = {
  'Wi-Fi': [{ family: 'IPv4', address: '192.168.10.23', cidr: '192.168.10.23/24', internal: false },  // scan-secrets:allow (made-up address)
    { family: 'IPv6', address: 'fe80::1', cidr: 'fe80::1/64', internal: false }],
  Ethernet: [{ family: 'IPv4', address: '10.20.30.40', cidr: '10.20.30.40/16', internal: false }],  // scan-secrets:allow (made-up address)
  'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }],
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.25.160.1', cidr: '172.25.160.1/20', internal: false }],  // scan-secrets:allow (made-up address)
  docker0: [{ family: 'IPv4', address: '172.17.0.1', cidr: '172.17.0.1/16', internal: false }],  // scan-secrets:allow (made-up address)
  tailscale0: [{ family: 'IPv4', address: '100.64.1.2', cidr: '100.64.1.2/32', internal: false }],
  wan: [{ family: 'IPv4', address: '198.51.100.7', cidr: '198.51.100.7/24', internal: false }],
  small: [{ family: 'IPv4', address: '192.168.50.70', cidr: '192.168.50.70/26', internal: false }],  // scan-secrets:allow (made-up address)
};

test('subnets: private interfaces only, at most the /24 around the address; virtual ones skipped', () => {
  const r = D.scanSubnets({ interfaces: IFACES });
  assert.deepEqual(r.subnets.map(s => s.text), ['192.168.10.0/24', '10.20.30.0/24', '192.168.50.64/26']);  // scan-secrets:allow (made-up address)
  assert.deepEqual(r.skipped.sort(), ['Loopback Pseudo-Interface 1', 'docker0', 'tailscale0', 'vEthernet (WSL)']);
  const hosts = D.hostsOf(r.subnets[0]);
  assert.equal(hosts.length, 253, '254 host addresses minus this computer');
  assert.ok(!hosts.includes('192.168.10.23') && !hosts.includes('192.168.10.0') && !hosts.includes('192.168.10.255'));  // scan-secrets:allow (made-up address)
  assert.equal(D.hostsOf(r.subnets[2]).length, 61);
  const given = D.scanSubnets({ scan: ['192.168.77.0/24', '10.0.0.0/22'], interfaces: IFACES });
  assert.equal(given.from, 'scan_subnets');
  assert.deepEqual(given.subnets.map(s => s.text), ['192.168.77.0/24', '10.0.0.0/22']);
  assert.equal(D.hostsOf(given.subnets[1]).length, 1022);
});

test('the probe: an open port is found, a closed one not; only connect and close', async () => {
  const received = [];
  const server = net.createServer(s => { s.on('data', d => received.push(d)); s.on('error', () => {}); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await D.probeHosts(['127.0.0.1'], port, { timeoutMs: 1000 });
    assert.deepEqual(r.open, ['127.0.0.1']);
    assert.equal(r.probed, 1);
    const closed = await D.probeHosts(['127.0.0.1'], port + 1 === 65536 ? port - 1 : port + 1, { timeoutMs: 1000 });
    assert.deepEqual(closed.open, []);
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(received, [], 'nothing was sent');
  } finally {
    await new Promise(r => server.close(r));
  }
});

// A socket stand-in: 'open', 'refused' or 'silent' (never answers; the
// socket's own timeout fires), chosen per host and pass.
function fakeConnect(behaviour) {
  const { EventEmitter } = require('events');
  const calls = [];
  const connect = host => {
    const pass = calls.filter(c => c.host === host).length + 1;
    const s = new EventEmitter();
    let timer = null;
    s.destroy = () => clearTimeout(timer);
    s.setTimeout = (ms, cb) => { calls.push({ host, pass, ms }); if (behaviour(host, pass) === 'silent') timer = setTimeout(cb, ms); };
    setImmediate(() => {
      const b = behaviour(host, pass);
      if (b === 'open') s.emit('connect');
      else if (b === 'refused') s.emit('error', Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    });
    return s;
  };
  return { connect, calls };
}

test('the probe: a host that only times out gets a second, longer try; a refused one does not', async () => {
  const hosts = ['192.0.2.60', '192.0.2.61', '192.0.2.62', '192.0.2.63'];
  // .62 answers only on the second pass (cold ARP), .61 refuses, .60 is open, .63 never answers.
  const f = fakeConnect((h, pass) => (h === '192.0.2.60' ? 'open' : h === '192.0.2.61' ? 'refused' : h === '192.0.2.62' && pass === 2 ? 'open' : 'silent'));
  const r = await D.probeHosts(hosts, 5555, { timeoutMs: 20, retryTimeoutMs: 60, budgetMs: 2000, connect: f.connect });
  assert.deepEqual(r.open, ['192.0.2.60', '192.0.2.62']);
  assert.equal(r.timedOut, false);
  assert.equal(r.probed, 4);
  const second = f.calls.filter(c => c.pass === 2);
  assert.deepEqual(second.map(c => c.host).sort(), ['192.0.2.62', '192.0.2.63'], 'only the silent ones, not the refused one');
  assert.ok(second.every(c => c.ms === 60), 'the longer timeout');
  assert.ok(f.calls.filter(c => c.pass === 1).every(c => c.ms === 20));
  assert.equal(D.RETRY_TIMEOUT_MS, 1500);
});

test('the probe: the second pass keeps to the same budget', async () => {
  const hosts = Array.from({ length: 40 }, (_, i) => `192.0.2.${i + 1}`);
  const f = fakeConnect(() => 'silent');
  const t0 = Date.now();
  const r = await D.probeHosts(hosts, 5555, { timeoutMs: 20, retryTimeoutMs: 5000, parallel: 40, retryParallel: 4, budgetMs: 300, connect: f.connect });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true, 'stopped at the limit');
  assert.ok(took >= 280 && took < 1500, `${took} ms`);
  assert.ok(f.calls.some(c => c.pass === 2), 'the second pass started');
});

test('the probe stops at its budget', async () => {
  const hosts = Array.from({ length: 300 }, (_, i) => `192.0.2.${(i % 250) + 1}`);
  // A socket that never connects: no packet leaves this machine.
  const { EventEmitter } = require('events');
  const silent = () => Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
  const t0 = Date.now();
  const r = await D.probeHosts(hosts, 5555, { timeoutMs: 5000, parallel: 4, budgetMs: 300, connect: silent });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 2000);
});

// The adb server was already running.
const WARM = async () => ({ started: false, ms: 5 });

test('the report: candidates with the next step each, connected ones marked, nothing connected', async () => {
  const out = await D.discover({ deps: {
    startServer: WARM,
    mdns: async () => MDNS,
    devices: async () => 'List of devices attached\n192.0.2.30:5555\tdevice\n',
    interfaces: { lan: [{ family: 'IPv4', address: '192.0.2.10', cidr: '192.0.2.10/24', internal: false }] },
    probe: async () => ({ open: [], probed: 0, timedOut: false }),
  } });
  assert.match(out, /^Discovery in [\d.]+ s: mDNS through adb, port 5555 in no private subnet found\. Nothing was connected\.\nFound:\n/);
  // its pairing screen is open too (the same ip): pair first, with that address
  assert.ok(out.includes('adb-R5CX00000AB-AbCdEf 192.0.2.21:38123 (mDNS _adb-tls-connect._tcp) - pair first: adb_pair host=192.0.2.21:41234 code=<the 6-digit code on its screen>, then adb_connect host=192.0.2.21:38123'), out);
  assert.match(out, /192\.0\.2\.21:41234 \(mDNS _adb-tls-pairing\._tcp\) - the pairing screen is open: adb_pair host=192\.0\.2\.21:41234 code=<the 6-digit code on its screen>/);
  assert.match(out, /Android_TV_0001 192\.0\.2\.30:5555 \(mDNS _adb\._tcp\) - already connected/);

  const tv = await D.discover({ scan: ['192.168.77.0/24'], deps: {
    startServer: WARM,
    mdns: async () => { throw new Error('unknown command mdns'); },
    devices: async () => 'List of devices attached\n',
    probe: async hosts => ({ open: hosts.includes('192.168.77.50') ? ['192.168.77.50'] : [], probed: hosts.length, timedOut: false }),  // scan-secrets:allow (made-up address)
  } });
  assert.match(tv, /port 5555 in 192\.168\.77\.0\/24 \(scan_subnets\)/);
  assert.match(tv, /192\.168\.77\.50:5555 \(port 5555 open, network debugging\) - adb_connect host=192\.168\.77\.50:5555; if this computer is new to the device, it asks on its screen to allow debugging/);
  assert.match(tv, /Note: mDNS: not available from this adb \(unknown command mdns\)/);

  const none = await D.discover({ deps: { startServer: WARM, mdns: async () => 'List of discovered mdns services\n', mdnsCheck: async () => false, devices: async () => '', interfaces: {}, probe: async () => ({ open: [], probed: 0, timedOut: false }) } });
  assert.match(none, /Found nothing\. Check: debugging is on on the device/);
  assert.match(none, /not a guest network, no Wi-Fi client isolation/);
  assert.match(none, /Note: mDNS: no device announced Wireless debugging/);
});

const HEADER = 'List of discovered mdns services\n';
const PHONE = `${HEADER}adb-R5CX00000AB-AbCdEf\t_adb-tls-connect._tcp\t192.0.2.51:38123\n`;
const PHONE_AND_SHIELD = `${PHONE}SHIELD_0001\t_adb._tcp\t192.0.2.38:5555\n`;

// discover with the adb server start, the mDNS answers in turn and the probe as given.
async function discoverWith({ startServer, answers = [HEADER], check = false, probe }) {
  const asked = [], slept = [], order = [];
  const out = await D.discover({ scan: ['192.168.77.0/30'], deps: {  // scan-secrets:allow (made-up address)
    startServer: async () => { order.push('start-server'); return startServer(); },
    mdns: async () => { asked.push(1); return answers[Math.min(asked.length - 1, answers.length - 1)]; },
    mdnsCheck: async () => check,
    devices: async () => 'List of devices attached\n',
    probe: async hosts => { order.push('probe'); return probe ? probe(hosts) : { open: [], probed: hosts.length, timedOut: false }; },
    sleep: async ms => { slept.push(ms); },
  } });
  return { out, asked: asked.length, slept, order };
}

test('discover on a cold adb server: the start is reported apart from the search; mDNS is asked twice and merged', async () => {
  const r = await discoverWith({
    startServer: async () => { await new Promise(res => setTimeout(res, 30)); return { started: true, ms: 22400 }; },
    answers: [PHONE, PHONE_AND_SHIELD],
  });
  assert.deepEqual(r.order, ['probe', 'start-server'], 'the port scan starts before the adb server start, in parallel');
  assert.equal(r.asked, 2, 'asked again although the first answer was not empty');
  assert.deepEqual(r.slept, [D.MDNS_RETRY_MS]);
  assert.match(r.out, /^Discovery in [\d.]+ s \(22\.4 s of it starting the adb server\): mDNS through adb/);
  assert.match(r.out, /\nNote: adb server started \(22\.4 s\)/);
  assert.equal(r.out.split('\n').filter(l => l.includes('192.0.2.51:38123')).length, 1, 'merged by address');
  assert.match(r.out, /SHIELD_0001 192\.0\.2\.38:5555 \(mDNS _adb\._tcp\)/, 'what only the second answer had');
  assert.equal(D.MDNS_RETRY_MS, 2000);
  assert.equal(D.START_SERVER_TIMEOUT_MS, 45000);
});

test('a Wireless debugging device without its pairing screen: connect if paired, else how to pair', async () => {
  const r = await discoverWith({ startServer: WARM, answers: [PHONE] });
  assert.ok(r.out.includes('  adb-R5CX00000AB-AbCdEf 192.0.2.51:38123 (mDNS _adb-tls-connect._tcp) - adb_connect host=192.0.2.51:38123 if this computer is paired with the device; ' +
    'otherwise pair first: on the device, Wireless debugging -> Pair device with pairing code, then adb_pair'), r.out);
  assert.ok(!r.out.includes('paired:'));
});

test('discover on a warm adb server: one ask; empty with a working mdns check: one more', async () => {
  const warm = await discoverWith({ startServer: WARM, answers: [PHONE] });
  assert.equal(warm.asked, 1);
  assert.match(warm.out, /^Discovery in [\d.]+ s: mDNS through adb/);
  assert.ok(!/adb server started/.test(warm.out));
  const empty = await discoverWith({ startServer: WARM, answers: [HEADER, PHONE], check: true });
  assert.equal(empty.asked, 2);
  assert.match(empty.out, /192\.0\.2\.51:38123/);
  const broken = await discoverWith({ startServer: WARM, answers: [HEADER, PHONE], check: false });
  assert.equal(broken.asked, 1, 'mdns check fails: no second ask');
  assert.match(broken.out, /Note: mDNS: no device announced Wireless debugging/);
});

test('discover when adb start-server fails: mDNS is not asked, the port scan still answers', async () => {
  const r = await discoverWith({
    startServer: async () => { throw new Error('adb start-server timed out after 45 s and was killed\nmore'); },
    probe: async () => ({ open: ['192.0.2.62'], probed: 1, timedOut: false }),
  });
  assert.equal(r.asked, 0);
  assert.match(r.out, /\nNote: adb server could not be started \(adb start-server timed out after 45 s and was killed\): mDNS was not asked, only port 5555 was checked/);
  assert.match(r.out, /192\.0\.2\.62:5555 \(port 5555 open, network debugging\)/);
});

test('the report: an address found by mDNS and by the port scan is one line with both sources', async () => {
  const both = mdns => D.discover({ scan: ['192.168.77.0/24'], deps: {  // scan-secrets:allow (made-up address)
    startServer: WARM,
    mdns: async () => mdns,
    devices: async () => 'List of devices attached\n',
    probe: async () => ({ open: ['192.0.2.38', '192.0.2.62'], probed: 254, timedOut: false }),
  } });
  const out = await both('List of discovered mdns services\nSHIELD_0001\t_adb._tcp\t192.0.2.38:5555\n');
  const found = out.split('\n').filter(l => l.startsWith('  '));
  assert.deepEqual(found, [
    '  SHIELD_0001 192.0.2.38:5555 (mDNS _adb._tcp, port 5555 open, network debugging) - adb_connect host=192.0.2.38:5555; if this computer is new to the device, it asks on its screen to allow debugging',
    '  192.0.2.62:5555 (port 5555 open, network debugging) - adb_connect host=192.0.2.62:5555; if this computer is new to the device, it asks on its screen to allow debugging',
  ]);
  const twice = await both('List of discovered mdns services\nSHIELD_0001\t_adb._tcp\t192.0.2.38:5555\nSHIELD_0001\t_adb._tcp.\t192.0.2.38:5555\n');
  assert.equal(twice.split('\n').filter(l => l.includes('192.0.2.38')).length, 1, 'the same service announced twice: one line');
});

test('adb_devices discover=true over the dispatcher: mDNS from the fake adb, the scan within its limits', async () => {
  useFakeAdb([
    { match: '^start-server$', stdout: '' },
    { match: '^mdns services$', stdout: MDNS },
    { match: '^devices$', stdout: 'List of devices attached\n' },
  ]);
  S.init({ scan_subnets: ['192.168.77.0/32'] });  // no address to probe: the test touches no network
  require('../src/adb.js').useTestRunner(process.execPath, [require('./helpers.js').FAKE_ADB]);
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'adb_devices', arguments: { discover: true } } });
  const textOut = r.result.content[0].text;
  assert.match(textOut, /port 5555 in 192\.168\.77\.0\/32 \(scan_subnets\)\. Nothing was connected\./);
  assert.match(textOut, /adb_pair host=192\.0\.2\.21:41234/);
  S.init({});
});
