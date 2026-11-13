# Builds dist/release/Backlash Tool Guide.docx: README text + the illustrated
# "How to read it" figures cropped from a headless screenshot of the page.
# Usage: powershell -ExecutionPolicy Bypass -File make-guide-docx.ps1 <guide_full.png>
param([Parameter(Mandatory)][string]$Shot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$out  = Join-Path $PSScriptRoot 'dist\release\Backlash Tool Guide.docx'
$tmp  = Join-Path $env:TEMP ('btguide_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null

# crop the page sections (original pixel rows, 1000 px wide screenshot)
$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Shot))
$crops = [ordered]@{ measure = @(341,1353); table = @(1355,1807); live = @(1809,2431) }  # whole cards, found by scanning for the gaps between them
$imgs = @{}
foreach ($k in $crops.Keys) {
  $y0,$y1 = $crops[$k]
  $rect = New-Object System.Drawing.Rectangle 0,$y0,$src.Width,($y1-$y0)
  $bmp = $src.Clone($rect, $src.PixelFormat)
  $p = Join-Path $tmp "$k.png"; $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  $imgs[$k] = $p
}
$src.Dispose()

# Word: start our OWN instance, refuse if Word is already open (never touch the user's documents)
if (Get-Process WINWORD -ErrorAction SilentlyContinue) { throw 'Word is open -- close it first so this cannot touch your documents.' }
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $doc = $word.Documents.Add()
  $s = $word.Selection
  function Head($t,$lvl){ $s.Style = $doc.Styles.Item("Heading $lvl"); $s.TypeText($t); $s.TypeParagraph() }
  function P($t){ $s.Style = $doc.Styles.Item('Normal'); $s.TypeText($t); $s.TypeParagraph() }
  function B($t){ $s.Style = $doc.Styles.Item('List Bullet'); $s.TypeText($t); $s.TypeParagraph() }
  function N($t){ $s.Style = $doc.Styles.Item('List Number'); $s.TypeText($t); $s.TypeParagraph() }
  function IMG($p,$cap){ $s.Style = $doc.Styles.Item('Normal')
    # single line spacing on the picture's paragraph: a fixed/"exactly" spacing clips the image over the text
    $s.ParagraphFormat.LineSpacingRule = 0; $s.ParagraphFormat.SpaceBefore = 6; $s.ParagraphFormat.SpaceAfter = 0; $s.ParagraphFormat.KeepWithNext = -1
    $sh = $s.InlineShapes.AddPicture($p); $w = 468; $sh.Height = $sh.Height * $w / $sh.Width; $sh.Width = $w
    $s.TypeParagraph(); $s.Style = $doc.Styles.Item('Caption'); $s.TypeText($cap); $s.TypeParagraph() }

  $s.Style = $doc.Styles.Item('Title'); $s.TypeText('Backlash Tool'); $s.TypeParagraph()
  P 'Measure your mount''s backlash in milliseconds with your guide camera, and watch it change live while you adjust the gears. Works with any mount PHD2 can pulse-guide: worm gears (spring-loaded or fixed worm blocks), spur gears, belts. Built while adjusting the declination worm block of a Losmandy G11; the illustrations use that mount''s real before-and-after runs of 4 November 2026. Version 1.0.0.'

  Head 'Synopsis' 1
  P 'A guide pulse turns the motor at the guide rate. If the gear train has slack, the first part of every pulse after a change of direction is spent closing the gap, and the star does not move. The tool sends pulses in small steps, finds the star after each one through PHD2, and computes:'
  P '    slack (ms) = commanded time of the leg - star travel / guide rate'
  P 'It is scored at the guide rate your mount is set to (you enter it; 0.5x sidereal = 7.52"/s is common). The speed fitted from the run itself is shown separately as "fitted rate" (springiness): on a real mount it varies by about 10% from run to run, and scoring against it made results jump around.'
  Head 'Measure mode' 2
  P 'K steps one way (preload), 2K back (reversal 1), K forward (reversal 2). Net command is zero, so the pointing comes back to roughly where it was. Gives two slack figures and their average: the number to compare between adjustments. Keep the step, the step count and the pose the same between runs.'
  Head 'Live adjust mode' 2
  P 'Short legs back and forth for as long as you like (it stops itself after 45 minutes), a reversal every 20 to 30 seconds, and a slack figure after every reversal, with a pair average of the last two (opposite directions, so slow drift cancels). Turn a screw and see the effect within a minute. If you knock the mount, the star jumps: that leg is thrown away and the run carries on. With a Losmandy Gemini-II connected (optional) it also shows the motor effort beside each reversal. Slack going down while effort climbs is the warning: the worm is starting to bind, and you are trading backlash for friction and stalls.'
  Head 'Why not just watch PHD2''s guide graph?' 2
  B 'Guiding hides the slack. PHD2 keeps correcting, so a reversal shows up as a small overshoot mixed with seeing, not as a number of milliseconds.'
  B 'Reversals are rare. A well-aligned mount may reverse declination a few times an hour. Live adjust forces one every 20 to 30 seconds.'
  B 'Everything is mixed together: seeing, drift, periodic error, dithers, backlash compensation. The tool moves one axis on purpose and measures only that.'

  Head 'How to read it' 1
  P 'The same figures appear in the program''s "How to read it" tab. Numbered callouts are explained beneath each figure.'
  IMG $imgs.measure 'Figure 1. The Measure chart, with numbered callouts. Grey dashed: before adjustment (about 6000 ms of slack). Orange: after (about 3800 ms).'
  IMG $imgs.table   'Figure 2. The result table, column by column.'
  IMG $imgs.live    'Figure 3. The Live adjust chart (illustration, not a real run): one dot per reversal, the pair average, an adjustment, a star jump, and the effort bars.'

  Head 'Running it' 1
  N 'Start PHD2. Tick Tools > Enable Server. Connect camera and mount.'
  N 'Point somewhere comfortable (for RA, below about Dec 70). Mount tracking.'
  N 'PHD2 looping, not guiding, with a clear star that is not saturated.'
  N 'Start the tool. A browser page opens at http://localhost:7171.'
  B 'Windows: double-click BacklashTool-win-x64.exe. SmartScreen may warn about an unknown publisher (the file is not code-signed): More info > Run anyway. Keep its console window open while you use it; close it to quit.'
  B 'macOS: install Node.js (LTS) from nodejs.org once, then double-click "Start Backlash Tool.command" (in the same folder as backlash-tool.cjs). The first time, right-click > Open. Not yet tested on a Mac by the author.'
  B 'Linux / anything else: node backlash-tool.cjs'
  P 'Every run is saved as a CSV in Documents/BacklashTool.'

  Head 'A good adjusting session' 1
  N 'Run Measure once to get a starting number. Note the pose and keep it the same.'
  N 'Switch to Live adjust. Make one small change at a time (a fraction of a turn), then wait for two or three reversals.'
  N 'Watch effort, if you have it, and listen to the mount. Smaller slack with rising effort is a worse mount, not a better one.'
  N 'When the pair average stops improving, back off slightly and run Measure again to record the final number.'
  N 'Check cold: gear trains tighten as they cool. Adjusting warm and running cold is a classic way to get stalls.'
  N 'Then let your guiding software set its backlash compensation from its own test (PHD2 Guiding Assistant).'
  P 'Run-to-run spread is about 10% even when nothing changed. Do not chase a 5% difference; repeat the run.'

  Head 'Worked example: the spring adjuster, then the depth adjuster' 1
  P 'This is how the Losmandy G11 declination worm block was adjusted on 4 November 2026, with the tool''s numbers at each step. A spring-loaded worm block has two screws that both change how the worm meets the ring gear, and they do different jobs.'
  Head 'How the two screws relate' 2
  B 'The SPRING ADJUSTER sets the preload: how hard the spring pushes the worm into the ring gear. More preload holds the worm in mesh against the gear''s high and low spots, and takes up slack as long as the worm is free to move further in.'
  B 'The DEPTH ADJUSTER sets how far in the worm is allowed to go: the mesh depth itself. The spring can only push the worm as deep as the depth setting lets it.'
  B 'So they work in sequence. While the worm still has room to move inward, tightening the spring closes the gap. Once the worm is sitting at the depth limit, more spring force only presses harder against the stop: friction can rise, but the slack does not change. From that point only the depth screw moves the mesh.'
  P 'That is our reading of the night''s measurements, not something taken apart and inspected. The numbers below are what it rests on.'
  Head 'When to stop with the spring and start on the depth' 2
  P 'Switch when the spring adjuster stops changing the backlash. On the G11 that was clear after the fourth round: two spring turns took the PHD2 Guiding Assistant figure from 4429 ms to 3878 ms (-12%), and a third turn left it at 3895 ms, no change within the noise. The turn also felt like too much in the hand. A screw that no longer moves the number has run out of useful travel, so the work moved to the depth adjuster.'
  P 'With the depth screw the rule is the opposite one: very small steps (about 1/60 turn), check after each, and back off as soon as one direction gets worse. The third depth turn made the North-to-South reversal 20% worse while South-to-North did not change, which is the sign of going one step too deep. Backing it off to the previous setting gave the best result of the night.'
  Head 'The rounds' 2
  $rows = @(
    @('Round','Adjustment','Slack, avg of reversals (ms)','PHD2 GA (ms)','Note'),
    @('1','Start (after earlier worm work)','6474','4429','Starting point'),
    @('2','Spring ~1/30 turn tighter','5203','',''),
    @('3','Spring, slightly less than 1/30','6100','3878','GA -12% over both turns'),
    @('4','Spring ~1/30 (felt too much)','5620','3895','Flat: spring has plateaued'),
    @('5','Depth ~1/60 turn in','4827','','-14%, first clear move 4500 ms (was 6000)'),
    @('6','Depth ~1/60 in again','4027','','-17%'),
    @('7','Depth third ~1/60 in','4847','','Worse N->S: one step too deep'),
    @('7r','Repeat, nothing changed','4136','','Shows the ~10% run-to-run noise'),
    @('8','Depth backed off to round-6 setting','3760','1234','Best of the night; FINAL')
  )
  $s.Style = $doc.Styles.Item('Normal')
  $t = $doc.Tables.Add($s.Range, $rows.Count, 5)
  $t.Borders.Enable = -1
  for ($r=0; $r -lt $rows.Count; $r++) { for ($c=0; $c -lt 5; $c++) { $t.Cell($r+1,$c+1).Range.Text = [string]$rows[$r][$c] } }
  $t.Rows.Item(1).Range.Font.Bold = -1
  $t.Rows.Item(10).Range.Font.Bold = -1
  $t.Range.Font.Size = 9
  $s.EndKey(6) | Out-Null
  P 'Slack is scored at the mount''s set guide rate (7.50"/s). Round 2''s average is from its two reversals; the others from the tool''s fixed-rate figures.'
  P 'Two things that do not show in the table. Motor effort while moving (Gemini PWM) did not climb at any point and there were no stalls, so the adjustment never traded backlash for binding. And at the final setting PHD2 offered backlash compensation (1230 ms) for the first time; it had refused at every earlier figure. With it applied, declination guiding held in Auto (both directions) at 0.28-0.32" RMS.'

  Head 'Safety' 1
  B 'It sends guide pulses only, through PHD2''s own guide_pulse, the same path a guide correction takes. It cannot slew or park.'
  B 'It refuses to run while PHD2 is guiding.'
  B 'Measure mode''s net command is zero. Live adjust steps back toward its start when stopped.'
  B 'The page is served on 127.0.0.1 only and rejects requests from other sites.'
  B 'The Gemini option only reads (GET /motor.cgx). The password is kept in memory, never saved.'

  Head 'Settings' 1
  P 'Environment variables: PHD2_HOST (127.0.0.1), PHD2_PORT (4400), BACKLASH_PORT (7171), BACKLASH_DATA (Documents/BacklashTool).'

  $doc.SaveAs2([string]$out, 16)
  if ($env:GUIDE_PDF) { $doc.ExportAsFixedFormat([string]$env:GUIDE_PDF, 17) }
  $st = $doc.ComputeStatistics(2), $doc.ComputeStatistics(0), $doc.InlineShapes.Count
  "saved $out  pages $($st[0])  words $($st[1])  pictures $($st[2])"
  $doc.Close([ref]0)
} finally {
  $word.Quit([ref]0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  Start-Sleep 1
  Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process -Force
  Remove-Item $tmp -Recurse -Force
}
