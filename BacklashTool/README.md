# Backlash Tool

Measure your mount's backlash in milliseconds with your guide camera, and watch it
change **live** while you adjust the gears.

Works with any mount PHD2 can pulse-guide: worm gears (spring-loaded or fixed worm blocks),
spur gears, belts. It was built adjusting the declination worm block of a Losmandy G11, and the
illustrated guide inside uses that mount's before and after runs.

## Synopsis

A guide pulse turns the motor at the guide rate. If the gear train has slack, the first part of
every pulse **after a change of direction** is spent closing the gap, and the star does not move.
The tool sends pulses in small steps, finds the star after each one through PHD2, and computes

    slack (ms) = commanded time of the leg - star travel / guide rate

It is scored at the **guide rate your mount is set to** (you enter it; 0.5x sidereal = 7.52"/s is
common). The speed fitted from the run itself is shown separately as "fitted rate" (springiness):
on a real mount it varies by about 10% from run to run, and scoring against it made results jump
around.

**Measure mode.** K steps one way (preload), 2K back (reversal 1), K forward (reversal 2). Net
command is zero, so the pointing comes back to roughly where it was. Gives two slack figures and
their average: the number to compare between adjustments. Keep the step, the step count and the
pose the same between runs.

**Live adjust mode.** Short legs back and forth for as long as you like (it stops itself after
45 minutes), a reversal every 20 to 30 seconds, and a slack figure after **every** reversal, with
a pair average of the last two (opposite directions, so slow drift cancels). Turn a screw and see
the effect within a minute. If you knock the mount, the star jumps: that leg is thrown away and
the run carries on. With a Losmandy Gemini-II connected (optional) it also shows the motor effort
beside each reversal. **Slack going down while effort climbs is the warning:** the worm is starting
to bind, and you are trading backlash for friction and stalls.

**Why not just watch PHD2's guide graph while adjusting?**
- Guiding hides the slack. PHD2 keeps correcting, so a reversal shows up as a small overshoot mixed
  with seeing, not as a number of milliseconds.
- Reversals are rare. A well-aligned mount may reverse declination a few times an hour. Live adjust
  forces one every 20 to 30 seconds.
- Everything is mixed together: seeing, drift, periodic error, dithers, backlash compensation. The
  tool moves one axis on purpose and measures only that.

The page has a full **How to read it** tab, with numbered callouts on every part of both charts
and the result table.

## Running it

1. Start PHD2. Tick **Tools > Enable Server**. Connect camera and mount.
2. Point somewhere comfortable (for RA, below about Dec 70). Mount tracking.
3. PHD2 **looping, not guiding**, with a clear star that is not saturated.
4. Start the tool. A browser page opens at `http://localhost:7171`.

| | |
| --- | --- |
| **Windows** | double-click `BacklashTool-win-x64.exe`. SmartScreen may warn about an unknown publisher (the file is not code-signed): **More info > Run anyway**. Keep its console window open while you use it; close it to quit. |
| **macOS** | install Node.js (LTS) from nodejs.org once, then double-click `Start Backlash Tool.command` (in the same folder as `backlash-tool.cjs`). The first time, macOS may refuse it: right-click > **Open**, or in Terminal run `chmod +x "Start Backlash Tool.command"`. **This has not been tested on a Mac by the author.** |
| **Linux / anything else** | `node backlash-tool.cjs` |

Every run is saved as a CSV in `Documents/BacklashTool`.

## Safety

- It sends **guide pulses only**, through PHD2's own `guide_pulse`, the same path a guide correction
  takes. It cannot slew or park.
- It refuses to run while PHD2 is guiding.
- Measure mode's net command is zero. Live adjust steps back toward its start when stopped.
- The page is served on 127.0.0.1 only and rejects requests from other sites.
- The Gemini option only reads (`GET /motor.cgx`). The password is kept in memory, never saved.

## Tips

- Run-to-run spread is about 10% even with nothing changed. Repeat before believing a 5% change.
- Adjust in small steps (a fraction of a turn) and wait for two or three reversals each time.
- Gear trains tighten as they cool. Check again on a cold night before trusting a warm adjustment.
- When done, let your guiding software set its backlash compensation from its own test (PHD2
  Guiding Assistant).

## Settings

Environment variables: `PHD2_HOST` (127.0.0.1), `PHD2_PORT` (4400), `BACKLASH_PORT` (7171),
`BACKLASH_DATA` (Documents/BacklashTool).

## Building (for the maintainer)

    node test/run-tests.cjs                 tests against a pretend PHD2 with known slack
    node build.cjs --bundle-only            dist/backlash-tool.cjs (page and sample inlined)
    powershell -File make-exe.ps1           dist/BacklashTool-win-x64.exe (Node's built-in SEA)
    node test/run-tests.cjs --exe dist/BacklashTool-win-x64.exe

Version 1.0.0.
