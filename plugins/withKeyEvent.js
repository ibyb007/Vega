const { withMainActivity } = require('@expo/config-plugins');

// NOTE: this plugin is listed *before* './plugins/with-native-nav-rail.js' in
// app.config.js, but Expo's mod system does not reliably run `withMainActivity`
// mods in plugins-array order -- in practice, with-native-nav-rail.js's
// dispatchKeyEvent edit has been observed running FIRST despite that
// ordering. When that happens, this plugin used to see `dispatchKeyEvent`
// already present (created by nav-rail's Back-key short circuit) and, since
// its only check was "does dispatchKeyEvent exist at all", it silently
// skipped installing the KeyEventModule forwarding entirely -- it still
// added the (now unused) import, which is how the bug slipped past a casual
// diff review: the import was there, the calls weren't.
//
// Fix: don't gate on "does dispatchKeyEvent exist" (that only tells you
// *something* is using the name, not that our forwarding is present).
// Gate on "is our forwarding call present", and if some other plugin already
// created the override shell, splice into it instead of no-op'ing.
module.exports = function withKeyEvent(config) {
  return withMainActivity(config, (config) => {
    let src = config.modResults.contents;

    // Kotlin MainActivity
    if (config.modResults.language === 'kt') {
      if (!src.includes('com.github.kevinejohn.keyevent.KeyEventModule')) {
        src = src.replace(
          /package\s+[\w.]+/,
          `$&\n\nimport android.view.KeyEvent\nimport com.github.kevinejohn.keyevent.KeyEventModule`
        );
      }
      if (!src.includes('KeyEventModule.getInstance()')) {
        const forwarding =
          '        if (event.action == KeyEvent.ACTION_DOWN) {\n' +
          '            KeyEventModule.getInstance().onKeyDownEvent(event.keyCode, event)\n' +
          '        }\n' +
          '        if (event.action == KeyEvent.ACTION_UP) {\n' +
          '            KeyEventModule.getInstance().onKeyUpEvent(event.keyCode, event)\n' +
          '        }\n';

        if (/override fun dispatchKeyEvent\([^)]*\)\s*:\s*Boolean\s*\{/.test(src)) {
          // Another plugin already created the override (e.g. nav-rail's
          // Back-key check) -- splice our forwarding in right before its
          // final `return super.dispatchKeyEvent(event)` fallthrough. That
          // keeps any early-return checks earlier in the body (like nav-rail's
          // Back short circuit) running -- and short-circuiting -- BEFORE
          // this forwarding, regardless of which plugin ran first.
          if (src.includes('return super.dispatchKeyEvent(event)')) {
            src = src.replace(
              /([ \t]*)return super\.dispatchKeyEvent\(event\)/,
              `${forwarding}$1return super.dispatchKeyEvent(event)`
            );
          } else {
            console.warn(
              '[withKeyEvent] Found an existing dispatchKeyEvent override without the expected ' +
                '`return super.dispatchKeyEvent(event)` fallthrough -- add this manually:\n' +
                forwarding
            );
          }
        } else {
          const method = `
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
${forwarding}        return super.dispatchKeyEvent(event)
    }
`;
          src = src.replace(/class MainActivity[^{]*\{/, `$&${method}`);
        }
      }
    }
    // Java MainActivity
    else if (config.modResults.language === 'java') {
      if (!src.includes('com.github.kevinejohn.keyevent.KeyEventModule')) {
        src = src.replace(
          /package\s+[\w.]+;/,
          `$&\n\nimport android.view.KeyEvent;\nimport com.github.kevinejohn.keyevent.KeyEventModule;`
        );
      }
      if (!src.includes('KeyEventModule.getInstance()')) {
        const forwarding =
          '        if (event.getAction() == KeyEvent.ACTION_DOWN) {\n' +
          '            KeyEventModule.getInstance().onKeyDownEvent(event.getKeyCode(), event);\n' +
          '        }\n' +
          '        if (event.getAction() == KeyEvent.ACTION_UP) {\n' +
          '            KeyEventModule.getInstance().onKeyUpEvent(event.getKeyCode(), event);\n' +
          '        }\n';

        if (/public boolean dispatchKeyEvent\([^)]*\)\s*\{/.test(src)) {
          if (src.includes('return super.dispatchKeyEvent(event)')) {
            src = src.replace(
              /([ \t]*)return super\.dispatchKeyEvent\(event\)/,
              `${forwarding}$1return super.dispatchKeyEvent(event)`
            );
          } else {
            console.warn(
              '[withKeyEvent] Found an existing dispatchKeyEvent override without the expected ' +
                '`return super.dispatchKeyEvent(event)` fallthrough -- add this manually:\n' +
                forwarding
            );
          }
        } else {
          const method = `
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
${forwarding}        return super.dispatchKeyEvent(event);
    }
`;
          src = src.replace(/public class MainActivity[^{]*\{/, `$&${method}`);
        }
      }
    }

    config.modResults.contents = src;
    return config;
  });
};
