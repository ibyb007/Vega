const { withMainActivity, withMainApplication } = require('expo/config-plugins');

// Wires the native TV nav rail (native-src/android/com/vega/{TVNavRailView,
// NavRailManager, NavIconView, NavRailModule}.kt) into the generated
// MainActivity/MainApplication. The .kt files themselves are already copied
// into place by `with-custom-native-modules.js`'s generic native-src copy
// step -- this plugin only edits the two generated entry-point files.
//
// IMPORTANT: put this AFTER './plugins/withKeyEvent.js' in app.config.js's
// plugins array. It patches the dispatchKeyEvent override that plugin
// installs so the "rail has focus -> Back exits the app" check runs before
// KeyEventModule/RN ever sees the key event, mirroring the ordering
// guarantee the old JS hardwareBackPress listener relied on.
function withNativeNavRail(config) {
  config = withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes('add(NavRailPackage())')) {
      src = src.replace(
        /PackageList\(this\)\.packages\.apply \{\n/,
        (match) => `${match}              add(NavRailPackage())\n`
      );
    }
    cfg.modResults.contents = src;
    return cfg;
  });

  config = withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      console.warn(
        '[with-native-nav-rail] MainActivity is not Kotlin -- skipping (this plugin only supports Kotlin projects).'
      );
      return cfg;
    }

    let src = cfg.modResults.contents;

    // 1. Attach the rail once content is set.
    if (!src.includes('NavRailManager.attachToActivity')) {
      const onContentChanged = `
    override fun onContentChanged() {
        super.onContentChanged()
        NavRailManager.attachToActivity(this)
    }
`;
      src = src.replace(/class MainActivity[^{]*\{/, (match) => `${match}${onContentChanged}`);
    }

    // 1b. Tell the manager to drop its static references when this exact
    // Activity instance goes away, so a relaunch in the same still-alive
    // process (common on TV launchers/boxes after finishAffinity()) doesn't
    // find a stale rail and skip attaching a fresh one.
    if (!src.includes('NavRailManager.detachFromActivity')) {
      const onDestroy = `
    override fun onDestroy() {
        NavRailManager.detachFromActivity(this)
        super.onDestroy()
    }
`;
      src = src.replace(/class MainActivity[^{]*\{/, (match) => `${match}${onDestroy}`);
    }

    // 2. Back-key short circuit. Prefer merging into the dispatchKeyEvent
    // override installed by withKeyEvent.js; fall back to adding our own if
    // that plugin isn't present / already changed shape.
    if (!src.includes('NavRailManager.shouldExitOnBack')) {
      const backCheck =
        '        if (event.keyCode == android.view.KeyEvent.KEYCODE_BACK && event.action == android.view.KeyEvent.ACTION_DOWN && NavRailManager.shouldExitOnBack()) {\n' +
        '            finishAffinity()\n' +
        '            // Belt-and-suspenders alongside the onDestroy() hook above:\n' +
        '            // actually end the process on this intentional exit path\n' +
        '            // instead of hoping the OS reclaims it before the user\n' +
        '            // relaunches. Some TV launchers/boxes keep the process\n' +
        '            // alive after finishAffinity() and just start a fresh\n' +
        '            // Activity in it.\n' +
        '            android.os.Process.killProcess(android.os.Process.myPid())\n' +
        '            return true\n' +
        '        }\n';

      if (src.includes('override fun dispatchKeyEvent(event: KeyEvent): Boolean {')) {
        src = src.replace(
          'override fun dispatchKeyEvent(event: KeyEvent): Boolean {',
          (match) => `${match}\n${backCheck}`
        );
      } else if (!src.includes('override fun dispatchKeyEvent(')) {
        const dispatch = `
    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
${backCheck}        return super.dispatchKeyEvent(event)
    }
`;
        src = src.replace(/class MainActivity[^{]*\{/, (match) => `${match}${dispatch}`);
      } else {
        console.warn(
          '[with-native-nav-rail] Found an existing dispatchKeyEvent override in an unexpected shape -- add this check to it manually:\n' +
            backCheck
        );
      }
    }

    cfg.modResults.contents = src;
    return cfg;
  });

  return config;
}

module.exports = withNativeNavRail;
