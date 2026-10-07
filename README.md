# NRGkick for Homey

**Homey Pro app for the NRGkick EV charging cable: live charging data, control and Homey Energy, over the local network.**

The NRGkick (second generation) has a documented local JSON API, but there was no Homey app for it. This app talks
to that API directly, without a cloud service. Unofficial, not affiliated with DiniTech GmbH.

## Usage

1. In the NRGkick app, turn on **Extended → Local API → JSON API**. Optionally turn on Authentication (JSON).
2. In Homey, add a device: **NRGkick**. Pick the charger from the list (mDNS) or enter its IP address, plus the
   username and password when authentication is on.

| What | How |
|---|---|
| Pause / resume | The Charging toggle, or Homey's Start/Stop charging cards |
| Charging current | Slider (6 A up to the unit and attachment maximum), or *Set the charging current* |
| Energy limit | Slider in kWh (0 = no limit), or *Set the energy limit* |
| Phases | Picker, or *Set the number of phases* (needs phase switching enabled in the NRGkick app) |
| Homey Energy | Set *Target power mode* to Homey: the target power becomes a charging current; back to Automatic restores your own settings |
| Flows | Triggers: status changed, fault, warning, energy limit reached. Conditions: status is, fault active |

## Limits

- Second-generation NRGkick with WiFi only; SmartModule firmware 4.0.0.0 or newer. The first generation
  (Bluetooth only) has no local API.
- The device offers no push, so the app polls (default every 30 s, configurable 10-300 s).
- Solar charging and scheduled charging in the NRGkick app cannot be switched through the API.
- Cellular and GPS data of SIM models are not shown.

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
