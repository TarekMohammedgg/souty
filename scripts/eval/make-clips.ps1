# Generate the eval audio set from golden.json with the Windows OneCore voices (Hoda ar-EG, Zira en-US).
# '|' becomes a mid-sentence pause, '||' a pause between sentences, 'rate' speeds the voice up.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/eval/make-clips.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $here 'clips'
New-Item -ItemType Directory -Force $outDir | Out-Null

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }

$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$arVoice = $voices | Where-Object { $_.Language -eq 'ar-EG' } | Select-Object -First 1
$enVoice = $voices | Where-Object { $_.Language -eq 'en-US' } | Select-Object -First 1
if (-not $arVoice) { throw 'Arabic (Egypt) voice "Hoda" is not installed' }

$golden = Get-Content (Join-Path $here 'golden.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer

foreach ($clip in $golden.clips) {
  $isEnglish = $clip.lang -eq 'en'
  $synth.Voice = if ($isEnglish) { $enVoice } else { $arVoice }
  $lang = if ($isEnglish) { 'en-US' } else { 'ar-EG' }
  $rate = if ($clip.rate) { $clip.rate } else { 1.0 }

  $text = [Security.SecurityElement]::Escape($clip.say)
  $text = $text.Replace('||', '<break time="900ms"/>').Replace('|', '<break time="700ms"/>')
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='$lang'><prosody rate='$rate'>$text</prosody></speak>"

  $stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $size = [uint32]$stream.Size
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [IO.File]::WriteAllBytes((Join-Path $outDir "$($clip.id).wav"), $bytes)
  '{0}.wav  {1:N1}s' -f $clip.id, (($size - 44) / 32000.0)
}
