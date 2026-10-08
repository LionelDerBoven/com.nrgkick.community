'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

// NRGkick Discovery Protocol (NRGDP 1.0) from DiniTech's Connect API documentation: a "WHERE IS" message to a UDP
// multicast group, answered by every Connect module with a "DEVICE" message sent straight back, three times.

const GROUP = '239.255.255.250';
const PORT = 1905;
const MAX_MODULES = 10;

/** Parses a DEVICE message into `{ ip, mac, nrgName, nrgMac, online }`, or null for anything else. */
function parseDeviceMessage(text) {
  const lines = String(text || '').split(/\r?\n/);
  if (!/\*\*\s*DEVICE\s*\*\*/i.test(lines[0] || '')) return null;
  const fields = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) fields[line.slice(0, at).trim().toUpperCase()] = line.slice(at + 1).trim();
  }
  if (!fields.IP) return null;
  return {
    ip: fields.IP,
    mac: fields.MAC || '',
    nrgName: fields.NRGNAME || '',
    nrgMac: fields.NRGMAC || '',
    // The documentation names the flag NRGOFFLINE but describes true as "NRGkick connected"; that is followed here.
    online: fields.NRGOFFLINE === undefined ? null : fields.NRGOFFLINE.toLowerCase() === 'true',
  };
}

function whereIsMessage(ip) {
  const pid = crypto.randomUUID();
  return `** WHERE IS **\r\nDEVICE: Homey\r\nVERSION: 1.0\r\nIP: ${ip || ''}\r\nPID: ${pid}\r\n`;
}

/**
 * Asks the network for Connect modules and collects the answers for `timeoutMs`.
 * @param {object} options
 * @param {(fn: Function, ms: number) => any} options.timer a Homey timer (homey.setTimeout)
 * @param {string} [options.localIp] Homey's address, for the message (the module answers the sender anyway)
 * @param {number} [options.timeoutMs]
 * @param {string} [options.group] for tests
 * @param {number} [options.port] for tests
 */
function discoverConnectModules({
  timer, localIp = '', timeoutMs = 3000, group = GROUP, port = PORT,
}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch (err) {
        // already closed
      }
      resolve([...found.values()]);
    };
    socket.on('error', finish);
    socket.on('message', (message, remote) => {
      const device = parseDeviceMessage(message.toString('utf8'));
      if (!device || found.size >= MAX_MODULES) return;
      if (!device.ip) device.ip = remote.address;
      found.set(device.mac || device.ip, device);
    });
    socket.bind(0, () => {
      const message = Buffer.from(whereIsMessage(localIp));
      // UDP may drop a packet, so the question is asked twice.
      socket.send(message, port, group, () => {});
      timer(() => {
        if (!done) socket.send(message, port, group, () => {});
      }, 500);
    });
    timer(finish, timeoutMs);
  });
}

module.exports = { parseDeviceMessage, whereIsMessage, discoverConnectModules };
