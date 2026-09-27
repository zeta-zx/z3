// Zeta "Halo": a radial, mirrored spectrum ringing the album art, over an
// aurora tinted by the art's palette. The cover itself is drawn on top in
// HTML, centred, with radius RING_R of the short side.
//   iChannel0 = audio (row 0 spectrum, row 1 waveform), iChannel1 = art.

#define PI 3.14159265
#define TAU 6.28318531
#define RING_R 0.25

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = rot(0.5) * p * 2.02; a *= 0.5; }
  return v;
}

float spectrum(float x) { return texture(iChannel0, vec2(x, 0.25)).r; }
float wave(float x) { return texture(iChannel0, vec2(x, 0.75)).r - 0.5; }

vec3 palette(float t) {
  t = fract(t);
  vec3 a = mix(iColor0, iColor1, smoothstep(0.0, 0.5, t));
  return mix(a, iColor2 + 0.25, smoothstep(0.5, 1.0, t));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 p = (fragCoord - 0.5 * iResolution.xy) / min(iResolution.x, iResolution.y);
  float r = length(p);
  float a = atan(p.x, p.y); // 0 at top, ±PI at bottom
  float t = iTime;

  // --- aurora backdrop ---------------------------------------------------
  vec2 q = p * 1.4;
  float n1 = fbm(q + vec2(t * 0.05, -t * 0.04) + iRot * 0.08);
  float n2 = fbm(q * 1.7 - vec2(t * 0.03, t * 0.06) + n1 * 1.5);
  vec3 col = mix(iColor2 * 0.25, iColor0 * 0.55, smoothstep(0.25, 0.85, n2));
  col += iColor1 * 0.35 * pow(smoothstep(0.45, 0.95, n1), 2.0);
  col *= 0.55 + 0.45 * iLevel;

  // Light bloom radiating from behind the cover.
  float pulse = 1.0 + 0.12 * iBeat;
  col += palette(0.1) * 0.55 * exp(-max(r - RING_R, 0.0) * 5.5) * (0.35 + 0.65 * iLevel) * pulse;

  // --- mirrored radial spectrum -----------------------------------------
  // Bass at the top, highs toward the bottom, mirrored left/right.
  float x = abs(a) / PI;
  float bars = 96.0;
  float bi = floor(x * bars);
  float bx = (bi + 0.5) / bars;
  float amp = spectrum(pow(bx, 1.6) * 0.62 + 0.004);
  amp = pow(amp, 2.2) * (0.9 + 0.35 * iBeat);

  float inner = RING_R * pulse + 0.018;
  float len = 0.02 + amp * 0.3;
  float along = (r - inner) / len;
  float across = abs(fract(x * bars) - 0.5) * 2.0;           // 0 at bar centre
  float barWidth = smoothstep(0.62, 0.35, across);
  float bar = barWidth * smoothstep(-0.02, 0.0, along) * smoothstep(1.0, 0.85, along);
  vec3 barCol = palette(bx * 0.9 + t * 0.02) * (1.3 + 0.6 * along);
  col += barCol * bar;
  // Soft glow around the bars.
  col += barCol * 0.35 * barWidth * exp(-abs(along - 0.5) * 3.0) * smoothstep(0.0, 0.1, amp) * step(0.0, along);

  // --- waveform ring ------------------------------------------------------
  float wr = RING_R * pulse + 0.004 + wave(fract(a / TAU + 0.5)) * 0.06 * (0.5 + iLevel);
  col += palette(0.55) * 0.9 * smoothstep(0.006, 0.0, abs(r - wr)) * (0.4 + iLevel);

  // --- drifting motes -------------------------------------------------------
  vec2 g = p * 9.0 + vec2(0.0, -t * 0.25 - iTravel * 0.05);
  vec2 id = floor(g);
  vec2 gv = fract(g) - 0.5;
  float h = hash(id);
  vec2 off = vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5;
  float mote = smoothstep(0.06, 0.0, length(gv - off * 0.7)) * step(0.82, h);
  col += palette(h) * mote * (0.35 + 1.2 * iLevel) * smoothstep(RING_R, RING_R + 0.2, r);

  // Vignette.
  col *= 1.0 - 0.55 * dot(p, p);
  col += (hash(fragCoord + fract(t)) - 0.5) / 255.0;

  fragColor = vec4(max(col, 0.0), 1.0);
}
