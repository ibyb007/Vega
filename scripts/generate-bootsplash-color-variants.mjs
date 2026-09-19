import fs from 'node:fs';
import path from 'node:path';

// The splash art is a fixed brand mark (purple circle + play triangle,
// plus the VEGA TV wordmark) rather than something that should retint per
// the user's chosen launcher icon color -- so this script no longer
// recolors anything. It exists only
// to keep the 5 named variant files (which the native BootTheme.* styles
// each point at -- see plugins/with-dynamic-launcher-splash.js) all showing
// that same identical mark, so changing your launcher icon color never
// accidentally changes the boot splash too.
const variantNames = ['white', 'tomato', 'gray', 'blue', 'lavender'];
const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
const projectRoot = process.cwd();

for (const density of densities) {
  const sourcePath = path.join(
    projectRoot,
    'assets',
    'bootsplash',
    'android',
    `drawable-${density}`,
    'bootsplash_logo.png',
  );
  const source = fs.readFileSync(sourcePath);

  // The android/ project directory only exists after `expo prebuild` has
  // run at least once -- running this script fresh (e.g. right after
  // editing the source logo, before ever prebuilding) shouldn't crash
  // partway through the assets/bootsplash copies below just because that
  // directory isn't there yet.
  const nativeResDir = path.join(
    projectRoot,
    'android',
    'app',
    'src',
    'main',
    'res',
    `drawable-${density}`,
  );
  const hasNativeResDir = fs.existsSync(nativeResDir);

  for (const name of variantNames) {
    const filename = `bootsplash_logo_${name}.png`;

    fs.writeFileSync(path.join(path.dirname(sourcePath), filename), source);

    if (hasNativeResDir) {
      fs.writeFileSync(path.join(nativeResDir, filename), source);
    }
  }
}

