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
| Homey Energy | Set *Target power mode* to Homey: the target power becomes a charging current; back to Automatic restores your own settings |
| Flows | Triggers: car plugged in / unplugged, charging session ended (energy, times, cost), status changed, fault, warning, energy limit reached, location changed (SIM models). Conditions: car is plugged in, status is, fault active. Actions: charging current (set, raise, lower), charge … kWh and then stop, energy limit, phases, electricity price |
| Safety limit | Device setting *Maximum charging current*: the slider, Flows and Homey Energy never go above it, and a higher current set in the NRGkick app is lowered to it |
| Session cost | A fixed price per kWh in the device settings, or *Set the electricity price* from a Flow (e.g. Homey Energy's price trigger) for a dynamic tariff. Apps cannot read Homey Energy's prices directly |

## Limits

- Second-generation NRGkick with WiFi only; SmartModule firmware 4.0.0.0 or newer. The first generation
  (Bluetooth only) has no local API.
- The device offers no push, so the app polls (default every 30 s, configurable 10-300 s).
- Solar charging and scheduled charging in the NRGkick app cannot be switched through the API.
- **SIM models: untested.** Mobile network, signal, operator and GPS position (plus a *location changed* Flow
  card) are built from DiniTech's API documentation and tested against a simulated device only; no SIM model was
  available. They appear only on a model whose type contains "SIM". The position is read every 10 minutes.
  Feedback from SIM owners is welcome in the issues.

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
- `drivers/nrgkick/device.js`: polling, capabilities, Flow triggers, control and Homey Energy

## Credits

Built by LDB Technology, with [Claude](https://claude.com/claude-code) (Anthropic) as co-author.

## License

[GPL-3.0-or-later](LICENSE)
