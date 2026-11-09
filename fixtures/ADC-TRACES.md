# Real ADC traces (SLogic32 U3, A0, 16 ch @ 100 MS/s)

One byte per sample: the ADC code (the module's MSB-first wiring already undone), captured
on a real board through the app and exported raw. They pin the analog trigger
qualification (ARCHITECTURE.md, trigger section) to measured data.

| File | Signal | What it tests |
| --- | --- | --- |
| `adc-sine-carry-glitches-100MSps.bin` | ~10 kHz sine, codes 84..175, 300 000 samples (3 ms) | Carry-boundary glitches: at a transition old→new the bus can read `old \| new` (or that with bit 0 clear) for 1-14 samples (143→144 reads 159, 127→128 reads 255). A raw crossing test fires on the wrong slope; the qualified rule fires once per period on the configured slope. |
| `adc-am-3MHz-carrier-100MSps.bin` | AM wave, ~3.3 MHz carrier (~30 samples per period), 100 kHz modulation, codes ~95..161, 300 000 samples (3 ms) | A fast real signal: half a carrier period is ~15 samples. A rule that rejects runs shorter than 240 ns never triggers on it. |
| `adc-am-33MHz-carrier-100MSps.bin` | AM wave, ~33 MHz carrier (~3 samples per period), 1 MHz modulation, codes ~111..144, 100 000 samples (1 ms) | The extreme case: every crossing lasts one or two samples and is legitimate. |
| `adc-multitone-100kHz-100MSps.bin` | 100 kHz multitone (components near 0.1/0.29/0.39 MHz), codes ~95..161 plus glitches up to 255, 300 000 samples (3 ms) | Glitches that are the OR of the crossed pair or that OR with bit 0 clear: 127→128 reads 255/254 (runs of up to ~15 samples, some alternating), 96→95 reads 127/126. A rule that only accepts `old \| new` of the run's own neighbours fires Rising 200 thousands of times; the qualified rule fires on the configured slope at every reachable level and never at 200/230. The wave dwells on some levels in 4-6 sample runs between glitches. |
