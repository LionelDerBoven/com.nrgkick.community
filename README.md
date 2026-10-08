# NRGkick for Homey

**Homey Pro app for the NRGkick EV charging cable: live charging data, control and Homey Energy, over the local network.**

The NRGkick (second generation) has a documented local JSON API, but there was no Homey app for it. This app talks
to that API directly, without a cloud service. Unofficial, not affiliated with DiniTech GmbH.

## Usage

1. In the NRGkick app, turn on **Extended → Local API → JSON API**. Optionally turn on Authentication (JSON).
2. In Homey, add a device: **NRGkick**. Tap the charger in the list (mDNS) or enter its IP address. The app
   connects right away and only asks for a username and password when Authentication (JSON) is on.

| What | How |
|---|---|
| Pause / resume | The Charging toggle, or Homey's Start/Stop charging cards |
| Charging current | Slider (6 A up to the unit and attachment maximum), or *Set the charging current* |
| Energy limit | Slider in kWh (0 = no limit), or *Set the energy limit* |
| Phases | Picker, or *Set the number of phases* (needs phase switching enabled in the NRGkick app) |
| Homey Energy | Homey is in charge and the last command wins. A target power (Homey Energy or the card *Set target power*) becomes a charging current; below 6 A (about 1380 W on one phase) the NRGkick pauses, because a car cannot charge with less. When Homey Energy hands control back, your own current and pause state return |
| Flows | Triggers: car plugged in / unplugged, charging session ended (energy, times, cost), status changed, fault, warning, energy limit reached, location changed (SIM models). Conditions: car is plugged in, status is, and Homey's own "alarm is on" for faults. Actions: charging current (set, raise, lower), charge … kWh and then stop, energy limit, phases, electricity price |
| Safety limit | Device setting *Maximum charging current*: the slider, Flows and Homey Energy never go above it, and a higher current set in the NRGkick app is lowered to it |
| Session cost | A fixed price per kWh in the device settings, or *Set the electricity price* from a Flow (e.g. Homey Energy's price trigger) for a dynamic tariff. Apps cannot read Homey Energy's prices directly |

## Limits

- Second generation: WiFi models with SmartModule firmware 4.0.0.0 or newer.
- The device offers no push, so the app polls (default every 30 s, configurable 10-300 s).
- Solar charging and scheduled charging in the NRGkick app cannot be switched through the API.
- **SIM models: untested.** Mobile network, signal, operator and GPS position (plus a *location changed* Flow
  card) are built from DiniTech's API documentation and tested against a simulated device only; no SIM model was
  available. They appear only on a model whose type contains "SIM". The position is read every 10 minutes.
  Feedback from SIM owners is welcome in the issues.

## First generation (experimental, untested on hardware)

The first-generation NRGkick has no local JSON API. Two experimental drivers cover it. Neither has been tested on a
real unit yet: they follow the protocol descriptions below and are tested against simulated devices. Owners who
try them: turn on **Debug logging** in the device settings, then send a report with *Report a problem*, or open an
issue.

| Driver | How it connects | What works |
|---|---|---|
| **NRGkick Gen1 via Connect** | The NRGkick Connect module (WiFi bridge) over HTTP. Found on the network (UDP discovery) or by IP address | Power, energy, current/voltage/power per phase, temperature, errors. Pause/resume, charging current (whole amperes), energy limit and Homey Energy. Control needs the NRGkick's Bluetooth PIN in the device settings |
| **NRGkick Gen1 Bluetooth** | Homey's own Bluetooth, a short connection per read (default every 60 s) | Reading only: status, power, energy, current/voltage/power per phase, temperature, error code, current and energy limit. Control follows once the readings are confirmed |

Limits:

- **Connect**: the API cannot tell whether a car is plugged in, so without charging power the state shows "plugged
  in" (or "paused"). The Connect module drops requests that follow each other too closely; the app spaces them out.
- **Bluetooth: limited and untested.** It reads only; it cannot control charging yet.
- **Bluetooth range is short.** Homey must be close to the NRGkick: typically within about 10 m, ideally without
  walls in between. The cable often lies outside or in a garage while Homey stands inside, so check this first. If
  Homey is too far away, the device turns unavailable ("cannot reach the NRGkick over Bluetooth").
- While the NRGkick app on a phone is connected, Homey cannot connect, and while Homey reads, the phone app cannot.

Sources: DiniTech's *NRGkick Connect – JSON WEB API* (version 0.2, 2019) for the Connect module, and the Bluetooth
layout from [evcc](https://github.com/evcc-io/evcc) (MIT licence, `charger/nrg/ble`).

## Development

```bash
npm install
npm test
npm run lint
homey app validate --level verified
homey app run
```

Copy `.env.example` to `.env` to read a real device with `node tools/probe.js` (read-only).

- `lib/NrgkickClient.js`: HTTP client for the local API (auth, retries, error types, response size cap)
- `lib/mappings.js`: code tables, charging state, limits and watt/ampere conversion
- `lib/PollingDevice.js`: what the three devices share: polling with back-off, change-only writes, capability upkeep
- `drivers/nrgkick/device.js`: polling, capabilities, Flow triggers, control and Homey Energy
- `lib/ConnectClient.js`, `lib/connectDiscovery.js`, `drivers/nrgkick_connect/`: first generation via the Connect module
- `lib/gen1Ble.js`, `drivers/nrgkick_ble/`: first generation over Bluetooth (byte layout and reader)

## Credits

Built by LDB Technology, with [Claude](https://claude.com/claude-code) (Anthropic) as co-author. The first-generation
Bluetooth protocol description comes from [evcc](https://github.com/evcc-io/evcc) (MIT licence).

## License

[GPL-3.0-or-later](LICENSE)
