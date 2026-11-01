// HomeKit lights take hue (0-360°) and saturation (0-100 %); Matter
// controllers may also send CIE 1931 xy colours. Converted through sRGB at
// full brightness (brightness is a value of its own on both sides).

// sRGB (D65) linear RGB ↔ XYZ.
const RGB_TO_XYZ = [
  [0.4124, 0.3576, 0.1805],
  [0.2126, 0.7152, 0.0722],
  [0.0193, 0.1192, 0.9505],
];
const XYZ_TO_RGB = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.204, 1.057],
];

const toLinear = (c) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const fromLinear = (c) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
const multiply = (matrix, vector) =>
  matrix.map((row) =>
    row.reduce((sum, value, i) => sum + value * vector[i], 0),
  );

// Hue (°) and saturation (%) → [r, g, b], each 0-1, at full value.
function hsToRgb(hue, saturation) {
  const s = Math.min(100, Math.max(0, saturation)) / 100;
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = s * (1 - Math.abs((h % 2) - 1));
  const m = 1 - s;
  const [r, g, b] =
    h < 1
      ? [s, x, 0]
      : h < 2
        ? [x, s, 0]
        : h < 3
          ? [0, s, x]
          : h < 4
            ? [0, x, s]
            : h < 5
              ? [x, 0, s]
              : [s, 0, x];
  return [r + m, g + m, b + m];
}

// [r, g, b] → {hue (°), saturation (%)}.
function rgbToHs([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) {
      hue = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      hue = 60 * ((b - r) / delta + 2);
    } else {
      hue = 60 * ((r - g) / delta + 4);
    }
  }
  return {
    hue: (hue + 360) % 360,
    saturation: max === 0 ? 0 : (delta / max) * 100,
  };
}

// Hue (°) and saturation (%) → CIE xy, each 0-1.
function hsToXy(hue, saturation) {
  const [X, Y, Z] = multiply(
    RGB_TO_XYZ,
    hsToRgb(hue, saturation).map(toLinear),
  );
  const sum = X + Y + Z;
  return sum === 0 ? { x: 0.3127, y: 0.329 } : { x: X / sum, y: Y / sum };
}

// CIE xy → the nearest hue (°) and saturation (%) sRGB can show.
function xyToHs(x, y) {
  if (y <= 0) {
    return { hue: 0, saturation: 0 };
  }
  const linear = multiply(XYZ_TO_RGB, [x / y, 1, (1 - x - y) / y]).map((c) =>
    Math.max(0, c),
  );
  const peak = Math.max(...linear);
  if (peak === 0) {
    return { hue: 0, saturation: 0 };
  }
  return rgbToHs(linear.map((c) => fromLinear(c / peak)));
}

module.exports = { hsToXy, xyToHs };
