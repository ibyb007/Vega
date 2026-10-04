const fs = require('fs');
const path = require('path');
const {withDangerousMod} = require('expo/config-plugins');

/**
 * Adds a release signing config that reads from env vars, and points
 * buildTypes.release at it instead of the debug keystore.
 *
 * Previous version applied this via a *separately-applied* with-signing.
 * gradle file, inserted after "the last `apply from:` line found in
 * build.gradle at that point" -- which made whether signingConfigs.release
 * got created before buildTypes.release needed it entirely dependent on
 * where other plugins' own apply-from insertions happened to land first.
 * That's exactly the kind of thing that can work by coincidence for a long
 * time and then break the moment the generated template shifts even
 * slightly (a fresh clean prebuild, an Expo/AGP bump, plugin order
 * changing) -- which is what produced:
 *   "Could not get unknown property 'release' for SigningConfig container"
 *
 * This version instead inserts the signingConfigs.release block directly
 * as the first statement inside the main `android { ... }` block itself,
 * via brace-matched string insertion right after its opening `{`. That's
 * a single, fixed anchor -- not dependent on any other plugin's ordering
 * -- so signingConfigs.release is guaranteed to exist before anything else
 * in that block (including buildTypes.release, wherever the template puts
 * it) can reference it.
 */
module.exports = function withAndroidSigning(config) {
  return withDangerousMod(config, [
    'android',
    async cfg => {
      const projectRoot = cfg.modRequest.projectRoot;
      const appDir = path.join(projectRoot, 'android', 'app');
      const buildGradle = path.join(appDir, 'build.gradle');

      // Auto-copy keystore to android/app if it exists
      const keystoreSrc = path.join(projectRoot, 'vega-key.keystore');
      const keystoreDest = path.join(appDir, 'vega-key.keystore');
      if (fs.existsSync(keystoreSrc)) {
        fs.copyFileSync(keystoreSrc, keystoreDest);
      }

      let gradleText = fs.readFileSync(buildGradle, 'utf8');

      const marker = '// --- with-android-signing: begin ---';
      const alreadyApplied = gradleText.includes(marker);

      const signingConfigsBlock = `    ${marker}
    signingConfigs {
        release {
            def envStoreFile = System.getenv('MYAPP_UPLOAD_STORE_FILE')
            def envStorePassword = System.getenv('MYAPP_UPLOAD_STORE_PASSWORD')
            def envKeyAlias = System.getenv('MYAPP_UPLOAD_KEY_ALIAS')
            def envKeyPassword = System.getenv('MYAPP_UPLOAD_KEY_PASSWORD')

            if (envStoreFile && envStorePassword && envKeyAlias && envKeyPassword) {
                def keystoreFile = file(envStoreFile)
                println "Keystore file path: \${envStoreFile}"
                println "Keystore file exists: \${keystoreFile.exists()}"

                if (keystoreFile.exists()) {
                    storeFile keystoreFile
                    storePassword envStorePassword
                    keyAlias envKeyAlias
                    keyPassword envKeyPassword
                    println "Release signing config configured successfully"
                } else {
                    println "Keystore file not found: \${envStoreFile}"
                }
            } else {
                println "Missing signing environment variables:"
                println "  MYAPP_UPLOAD_STORE_FILE: \${envStoreFile}"
                println "  MYAPP_UPLOAD_STORE_PASSWORD: \${envStorePassword ? '***' : 'null'}"
                println "  MYAPP_UPLOAD_KEY_ALIAS: \${envKeyAlias}"
                println "  MYAPP_UPLOAD_KEY_PASSWORD: \${envKeyPassword ? '***' : 'null'}"
            }
        }
    }
    // --- with-android-signing: end ---
`;

      if (!alreadyApplied) {
        // Insert right after the FIRST "android {" (or "android{") opening
        // brace in the file -- the main extension block, not any nested
        // one -- so this is the very first thing configured inside it.
        const androidOpenMatch = gradleText.match(/android\s*\{/);
        if (!androidOpenMatch) {
          throw new Error(
            "with-android-signing: couldn't find the main 'android {' block in android/app/build.gradle to insert signingConfigs.release into.",
          );
        }
        const insertAt = androidOpenMatch.index + androidOpenMatch[0].length;
        gradleText =
          gradleText.slice(0, insertAt) +
          '\n' +
          signingConfigsBlock +
          gradleText.slice(insertAt);
      }

      // Point buildTypes.release at signingConfigs.release instead of
      // whatever the template defaults it to (usually signingConfigs.
      // debug). Done with an actual brace-matched scan of the release {}
      // block inside buildTypes {} rather than a single regex spanning
      // from "release {" to the signingConfig line -- a regex like that
      // silently stops at the *first* "}" it meets, which breaks the
      // moment the template puts any other nested block (ndk {}, a
      // buildConfigField call, etc.) before the signingConfig line.
      gradleText = redirectReleaseSigningConfig(gradleText);

      fs.writeFileSync(buildGradle, gradleText, 'utf8');

      return cfg;
    },
  ]);
};

/**
 * Finds `buildTypes { ... release { ... } ... }` via brace counting (not
 * regex) and, within that exact release block, points its signingConfig at
 * signingConfigs.release -- replacing an existing `signingConfig
 * signingConfigs.debug` line if present, or appending one if the block
 * doesn't set a signingConfig at all yet. Leaves buildTypes.debug alone.
 */
function redirectReleaseSigningConfig(text) {
  const buildTypesMatch = text.match(/buildTypes\s*\{/);
  if (!buildTypesMatch) return text;

  const buildTypesBody = extractBracedBlock(text, buildTypesMatch.index + buildTypesMatch[0].length - 1);
  if (!buildTypesBody) return text;

  const releaseMatch = buildTypesBody.text.match(/release\s*\{/);
  if (!releaseMatch) return text;

  const releaseOpenIndex = buildTypesBody.start + releaseMatch.index + releaseMatch[0].length - 1;
  const releaseBlock = extractBracedBlock(text, releaseOpenIndex);
  if (!releaseBlock) return text;

  let newInner = releaseBlock.inner;
  if (/signingConfig\s+signingConfigs\.\w+/.test(newInner)) {
    newInner = newInner.replace(
      /signingConfig\s+signingConfigs\.\w+/,
      'signingConfig signingConfigs.release',
    );
  } else {
    newInner = `\n            signingConfig signingConfigs.release${newInner}`;
  }

  return (
    text.slice(0, releaseBlock.innerStart) +
    newInner +
    text.slice(releaseBlock.innerEnd)
  );
}

/**
 * Given the index of an opening `{`, walks forward counting nested braces
 * to find its matching `}`. Returns the full block (including braces), the
 * inner content between them, and the absolute string indices of both, or
 * null if the braces never balance (malformed input).
 */
function extractBracedBlock(text, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        return {
          text: text.slice(openBraceIndex, i + 1),
          start: openBraceIndex,
          innerStart: openBraceIndex + 1,
          innerEnd: i,
          inner: text.slice(openBraceIndex + 1, i),
        };
      }
    }
  }
  return null;
}
