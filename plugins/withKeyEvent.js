const { withMainActivity } = require('@expo/config-plugins');

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
      if (!src.includes('dispatchKeyEvent')) {
        const method = `
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        KeyEventModule.getInstance().onKeyDownEvent(event.keyCode, event)
        KeyEventModule.getInstance().onKeyUpEvent(event.keyCode, event)
        return super.dispatchKeyEvent(event)
    }
`;
        src = src.replace(/class MainActivity[^{]*\{/, `$&${method}`);
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
      if (!src.includes('dispatchKeyEvent')) {
        const method = `
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        KeyEventModule.getInstance().onKeyDownEvent(event.getKeyCode(), event);
        KeyEventModule.getInstance().onKeyUpEvent(event.getKeyCode(), event);
        return super.dispatchKeyEvent(event);
    }
`;
        src = src.replace(/public class MainActivity[^{]*\{/, `$&${method}`);
      }
    }

    config.modResults.contents = src;
    return config;
  });
};
