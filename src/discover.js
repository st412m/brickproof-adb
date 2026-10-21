'use strict';
/**
 * discover.js — `adb_devices discover=true`: find devices that could be
 * connected, connect none of them (connecting shows a prompt on the device,
 * which is for the person to decide).
 *
 * Source 1: mDNS through adb itself (`adb mdns services`): phones, watches and
 * tablets with Wireless debugging, Android 11 and newer. adb prints a header
 * line, then one service per line: "<instance>\t<service>\t<ip>:<port>".
 * Parsed tolerantly; an empty or unsupported answer is a note, not an error.
 *
 * Source 2: TCP port 5555 (TV boxes with network debugging) in the private
 * IPv4 subnets of the host's interfaces, at most the /24 around each address,
 * or in scan_subnets. Only a TCP connect and a close: nothing is sent.
 */

const net = require('net');
const os = require('os');
const { adb } = require('./adb.js');
const { ipToInt, intToIp, isPrivateIp, parseSubnet } = require('./config.js');

const PORT = 5555;
const CONNECT_TIMEOUT_MS = 400;
const PARALLEL = 64;
// The second pass over the hosts that only timed out.
const RETRY_TIMEOUT_MS = 1500;
const RETRY_PARALLEL = 128;
const BUDGET_MS = 10000;

// Interfaces that are not the home network: containers, VMs, VPNs, tunnels.
const VIRTUAL_IF = /^(docker|br-|veth|virbr|vmnet|vboxnet|vnic|vEthernet|wsl|tun|tap|utun|wg|tailscale|zt|ppp|ipsec|gif|stf|awdl|llw|bridge|cni|flannel|cali|kube|lxc|lxd|podman|nordlynx|proton|ham)|virtual|vmware|virtualbox|hyper-v|loopback|vpn|tunnel/i;

/**
 * Parse `adb mdns services`: [{ instance, service, host, port, kind }], kind
 * 'pairing' | 'connect' | 'adb'. Lines without an ip:port and an _adb service
 * are skipped.
 */
function parseMdnsServices(out) {
  const found = [];
  for (const raw of String(out || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^list of discovered/i.test(line)) continue;
    const svc = /(_adb(?:-tls-(?:pairing|connect))?\._tcp)\.?/.exec(line);
    const addr = /((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\b/.exec(line);
    if (!svc || !addr) continue;
    const fields = line.split(/\t+|\s{2,}/);
    const instance = fields[0] && !fields[0].startsWith('_adb') && !/^\d/.test(fields[0]) ? fields[0].trim() : '';
    const service = svc[1];
    found.push({
      instance, service, host: addr[1], port: Number(addr[2]),
      kind: service === '_adb-tls-pairing._tcp' ? 'pairing' : service === '_adb-tls-connect._tcp' ? 'connect' : 'adb',
    });
  }
  return found;
}

/**
 * The subnets to scan: scan_subnets when set, else the private IPv4 networks
 * of the host's interfaces, each at most the /24 around the host's address.
 * Returns { subnets: [{ text, base, prefix, self }], skipped: [names] }.
 */
function scanSubnets({ scan = [], interfaces = os.networkInterfaces() } = {}) {
  if (scan.length) {
    return { subnets: scan.map(s => ({ ...parseSubnet(s), self: null })), skipped: [], from: 'scan_subnets' };
  }
  const subnets = [], skipped = [];
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    if (VIRTUAL_IF.test(name)) { skipped.push(name); continue; }
    for (const a of addrs || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      const ip = ipToInt(a.address);
      if (ip === null || !isPrivateIp(ip)) continue;
      const maskBits = a.cidr ? Number(a.cidr.split('/')[1]) : 24;
      const prefix = Math.max(24, Math.min(maskBits, 30));
      const mask = (0xffffffff << (32 - prefix)) >>> 0;
      const base = (ip & mask) >>> 0;
      const text = `${intToIp(base)}/${prefix}`;
      if (!subnets.some(s => s.text === text)) subnets.push({ text, base, prefix, self: a.address });
    }
  }
  return { subnets, skipped, from: 'interfaces' };
}

/** The host addresses of a subnet, without the network and broadcast addresses and the host itself. */
function hostsOf(subnet) {
  const size = 2 ** (32 - subnet.prefix);
  const out = [];
  for (let i = 1; i < size - 1; i++) {
    const ip = intToIp(subnet.base + i);
    if (ip !== subnet.self) out.push(ip);
  }
  return out;
}

/**
 * One pass of TCP connects: each host within timeoutMs, `parallel` at a time,
 * all before `deadline`. Resolves { open, timedOut: [hosts that did not
 * answer in time], probed, cut: whether the deadline stopped it }. A refused
 * or failed connect is a verdict; a timeout is not.
 */
function probePass(hosts, port, { timeoutMs, parallel, deadline, connect }) {
  return new Promise(resolve => {
    const open = [], silent = [];
    const sockets = new Set();
    let next = 0, running = 0, probed = 0, done = false;
    const finish = cut => {
      if (done) return;
      done = true;
      clearTimeout(budget);
      for (const s of sockets) s.destroy();
      resolve({ open, timedOut: silent, probed, cut });
    };
    const budget = setTimeout(() => finish(true), Math.max(0, deadline - Date.now()));
    const launch = () => {
      if (done) return;
      while (running < parallel && next < hosts.length && Date.now() < deadline) {
        const host = hosts[next++];
        running++;
        const s = connect(host, port);
        sockets.add(s);
        let settled = false;
        const end = verdict => {
          if (settled) return;
          settled = true;
          sockets.delete(s);
          s.destroy();
          running--;
          if (verdict === 'timeout') silent.push(host);
          else probed++;
          if (verdict === 'open') open.push(host);
          if (next >= hosts.length && running === 0) finish(false);
          else launch();
        };
        s.setTimeout(timeoutMs, () => end('timeout'));
        s.once('connect', () => end('open'));
        s.once('error', () => end('closed'));
      }
      if (next >= hosts.length && running === 0) finish(false);
    };
    launch();
  });
}

/**
 * TCP connect to port on every host: a first pass within timeoutMs each,
 * PARALLEL at a time; then the hosts that only timed out (a cold ARP entry, a
 * Wi-Fi radio asleep), once more within retryTimeoutMs each, RETRY_PARALLEL at
 * a time. Both passes within budgetMs. Returns { open: [ip], probed, timedOut }:
 * probed counts the hosts with an answer or a second chance, timedOut that
 * the budget stopped the scan. Exported for tests (a listener on 127.0.0.1,
 * `connect` replaced); the tool always uses 5555 and net.connect.
 */
async function probeHosts(hosts, port = PORT, { timeoutMs = CONNECT_TIMEOUT_MS, retryTimeoutMs = RETRY_TIMEOUT_MS,
  parallel = PARALLEL, retryParallel = RETRY_PARALLEL, budgetMs = BUDGET_MS,
  connect = (host, p) => net.connect({ host, port: p }) } = {}) {
  const deadline = Date.now() + budgetMs;
  const first = await probePass(hosts, port, { timeoutMs, parallel, deadline, connect });
  let open = first.open, probed = first.probed, cut = first.cut;
  if (!cut && first.timedOut.length) {
    const second = await probePass(first.timedOut, port, { timeoutMs: retryTimeoutMs, parallel: retryParallel, deadline, connect });
    open = open.concat(second.open);
    probed += second.probed + second.timedOut.length;
    cut = second.cut;
  } else if (!cut) {
    probed += first.timedOut.length;
  }
  return { open: open.sort((a, b) => ipToInt(a) - ipToInt(b)), probed, timedOut: cut };
}

function connectedSerials(devicesOut) {
  return String(devicesOut || '').split(/\r?\n/).slice(1)
    .map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
}

// A freshly started adb server answers `mdns services` before its mDNS
// browser has heard everything: one more ask after this pause.
const MDNS_RETRY_MS = 2000;
// Starting the adb server can take about 20 s on Windows; it is not part of
// the search's own budget.
const START_SERVER_TIMEOUT_MS = 45000;

// `adb start-server`: { started: whether this call started it, ms }.
async function startServer() {
  const t = Date.now();
  const r = await adb(['start-server'], { timeout: START_SERVER_TIMEOUT_MS, withStderr: true });
  return { started: /daemon not running|daemon started/i.test(String(r.stderr)), ms: Date.now() - t };
}

async function mdnsServices() {
  return String(await adb(['mdns', 'services'], { timeout: 10000 }));
}

// `adb mdns check`: whether adb's mDNS works at all.
async function mdnsCheck() {
  const out = String(await adb(['mdns', 'check'], { timeout: 5000 }));
  return !/unavailable|error/i.test(out);
}

/**
 * The discovery report. `deps` replace the network and adb in tests:
 * { startServer(): Promise<{ started, ms }>, mdns(): Promise<string>,
 *   mdnsCheck(): Promise<boolean>, devices(): Promise<string>, probe(hosts),
 *   interfaces, sleep(ms) }.
 * The port scan runs from the start, while the adb server starts and mDNS is
 * asked. mDNS is asked a second time after MDNS_RETRY_MS when this call
 * started the adb server, or when the first answer is empty while
 * `mdns check` works; the answers are merged.
 */
async function discover({ scan = [], deps = {} } = {}) {
  const t0 = Date.now();
  const notes = [];
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));

  const { subnets, skipped, from } = scanSubnets({ scan, interfaces: deps.interfaces });
  const hosts = subnets.flatMap(hostsOf);
  const probe = deps.probe || (h => probeHosts(h, PORT));
  const tcpRun = hosts.length ? probe(hosts) : Promise.resolve({ open: [], probed: 0, timedOut: false });

  let server = null;
  try {
    server = await (deps.startServer || startServer)();
    if (server.started) notes.push(`adb server started (${(server.ms / 1000).toFixed(1)} s)`);
  } catch (e) {
    notes.push(`adb server could not be started (${e.message.split('\n')[0]}): mDNS was not asked, only port ${PORT} was checked`);
  }

  let services = [];
  if (server) {
    const tMdns = Date.now();
    const ask = () => (deps.mdns || mdnsServices)();
    const first = await ask().catch(e => {
      notes.push(`mDNS: not available from this adb (${e.message.split('\n')[0]})`);
      return null;
    });
    if (first !== null) {
      services = parseMdnsServices(first);
      const again = server.started ||
        (!services.length && await (deps.mdnsCheck || mdnsCheck)().catch(() => false));
      if (again && Date.now() - tMdns + MDNS_RETRY_MS < BUDGET_MS) {
        await sleep(MDNS_RETRY_MS);
        const second = await ask().catch(() => null);
        if (second !== null) services = services.concat(parseMdnsServices(second));
      }
      if (!services.length) notes.push('mDNS: no device announced Wireless debugging');
    }
  }

  let connected = [];
  if (server) {
    try { connected = connectedSerials(await (deps.devices || (() => adb(['devices'])))()); } catch { /* listed as not connected */ }
  }

  const tcp = await tcpRun;

  // One line per ip:port, with every source that found it.
  const found = new Map();
  const entry = addr => {
    if (!found.has(addr)) found.set(addr, { addr, name: '', sources: [], kinds: new Set(), tcp: false });
    return found.get(addr);
  };
  for (const s of services) {
    const e = entry(`${s.host}:${s.port}`);
    if (s.instance && !e.name) e.name = s.instance;
    if (!e.sources.includes(`mDNS ${s.service}`)) e.sources.push(`mDNS ${s.service}`);
    e.kinds.add(s.kind);
  }
  for (const ip of tcp.open) {
    const e = entry(`${ip}:${PORT}`);
    e.sources.push(`port ${PORT} open`);
    e.tcp = true;
  }
  // The pairing address a device announces next to its connect address (the
  // same ip, another port), while its pairing screen is open.
  const pairingOf = addr => {
    const ip = addr.slice(0, addr.lastIndexOf(':'));
    const p = [...found.values()].find(x => x.kinds.has('pairing') && x.addr.startsWith(`${ip}:`));
    return p ? p.addr : null;
  };
  const lines = [];
  for (const e of found.values()) {
    const name = e.name ? `${e.name} ` : '';
    const where = `${name}${e.addr} (${e.sources.join(', ')}`;
    if (e.kinds.has('pairing'))
      lines.push(`  ${where}) - the pairing screen is open: adb_pair host=${e.addr} code=<the 6-digit code on its screen>`);
    else if (connected.includes(e.addr))
      lines.push(`  ${where}) - already connected`);
    else if (e.tcp)
      lines.push(`  ${where}, network debugging) - adb_connect host=${e.addr}; if this computer is new to the device, it asks on its screen to allow debugging`);
    else if (e.kinds.has('connect')) {
      // Wireless debugging announces this whoever is paired: it does not say
      // that this computer is.
      const pairing = pairingOf(e.addr);
      lines.push(pairing
        ? `  ${where}) - pair first: adb_pair host=${pairing} code=<the 6-digit code on its screen>, then adb_connect host=${e.addr}`
        : `  ${where}) - adb_connect host=${e.addr} if this computer is paired with the device; otherwise pair first: on the device, Wireless debugging -> Pair device with pairing code, then adb_pair`);
    } else
      lines.push(`  ${where}) - network debugging: adb_connect host=${e.addr}`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const scanned = subnets.length ? `${subnets.map(s => s.text).join(', ')} (${from})` : 'no private subnet found';
  const startNote = server && server.started ? ` (${(server.ms / 1000).toFixed(1)} s of it starting the adb server)` : '';
  const head = `Discovery in ${secs} s${startNote}: mDNS through adb, port ${PORT} in ${scanned}${tcp.timedOut ? `, stopped at the ${BUDGET_MS / 1000} s limit after ${tcp.probed} of ${hosts.length} addresses` : ''}. Nothing was connected.`;
  const body = lines.length ? `Found:\n${lines.join('\n')}`
    : 'Found nothing. Check: debugging is on on the device (Developer options: USB/network debugging, or Wireless debugging); ' +
      'the device is on the same network as this computer (not a guest network, no Wi-Fi client isolation); the TV is awake. ' +
      'An address read off the device screen works too: adb_connect host=<ip> (port 5555) or adb_pair for Wireless debugging.';
  const tail = [...notes, ...(skipped.length ? [`interfaces not scanned (virtual): ${skipped.join(', ')}`] : [])];
  return `${head}\n${body}${tail.length ? `\n${tail.map(n => `Note: ${n}`).join('\n')}` : ''}`;
}

module.exports = {
  PORT, CONNECT_TIMEOUT_MS, PARALLEL, RETRY_TIMEOUT_MS, RETRY_PARALLEL, BUDGET_MS, VIRTUAL_IF, MDNS_RETRY_MS, START_SERVER_TIMEOUT_MS,
  parseMdnsServices, scanSubnets, hostsOf, probeHosts, connectedSerials, discover,
};
