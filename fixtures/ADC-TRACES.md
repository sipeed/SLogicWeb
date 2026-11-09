# Real ADC traces (SLogic32 U3, A0, 16 ch @ 100 MS/s)

One byte per sample: the ADC code (the module's MSB-first wiring already undone), captured
on a real board through the app and exported raw. They pin the analog trigger
qualification (ARCHITECTURE.md, trigger section) to measured data.

| File | Signal | What it tests |
| --- | --- | --- |
| `adc-sine-carry-glitches-100MSps.bin` | ~10 kHz sine, codes 84..175, 300 000 samples (3 ms) | Carry-boundary OR artifacts: at a transition old→new the bus can read `old \| new` for 1-14 samples (143→144 reads 159, 127→128 reads 255). A raw crossing test fires on the wrong slope; the qualified rule fires once per period on the configured slope. |
| `adc-am-3MHz-carrier-100MSps.bin` | AM wave, ~3.3 MHz carrier (~30 samples per period), 100 kHz modulation, codes ~95..161, 300 000 samples (3 ms) | A fast real signal: half a carrier period is ~15 samples. A rule that rejects runs shorter than 240 ns never triggers on it. |
| `adc-am-33MHz-carrier-100MSps.bin` | AM wave, ~33 MHz carrier (~3 samples per period), 1 MHz modulation, codes ~111..144, 100 000 samples (1 ms) | The extreme case: every crossing lasts one or two samples and is legitimate. |
