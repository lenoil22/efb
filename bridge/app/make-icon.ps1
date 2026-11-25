# Erzeugt efb.ico (Programmsymbol): grüner Ring mit kleinem Flugzeug auf Nachtblau
Add-Type -AssemblyName System.Drawing
$sizes = 16, 32, 48, 256
$pngs = foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  $k = $s / 32.0
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(17, 24, 33))), 1 * $k, 1 * $k, 30 * $k, 30 * $k)
  $c = [System.Drawing.Color]::FromArgb(63, 224, 138)
  $g.DrawEllipse((New-Object System.Drawing.Pen $c, (3.2 * $k)), 2.5 * $k, 2.5 * $k, 27 * $k, 27 * $k)
  $pts = @(@(16,6),@(18,13),@(26,17),@(26,19),@(18,17),@(17.5,23),@(20,25),@(20,26.5),@(16,25.5),@(12,26.5),@(12,25),@(14.5,23),@(14,17),@(6,19),@(6,17),@(14,13)) |
    ForEach-Object { New-Object System.Drawing.PointF ($_[0] * $k), ($_[1] * $k) }
  $g.FillPolygon((New-Object System.Drawing.SolidBrush $c), [System.Drawing.PointF[]]$pts)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  , $ms.ToArray()
}
# ICO-Datei mit PNG-Einträgen zusammensetzen
$out = New-Object System.IO.MemoryStream; $w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$d.Length); $w.Write([uint32]$offset); $offset += $d.Length
}
foreach ($d in $pngs) { $w.Write([byte[]]$d) }
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'efb.ico'), $out.ToArray())
