const { withMainActivity } = require('@expo/config-plugins');

module.exports = function withAudioPreamp(config) {
  return withMainActivity(config, async (config) => {
    let content = config.modResults.contents;

    // Ensure Android AudioEffect imports exist
    if (!content.includes('android.media.audiofx.LoudnessEnhancer')) {
      content = content.replace(
        /package\s+com\.vega;?/,
        `package com.vega;

import android.media.audiofx.LoudnessEnhancer;
import android.media.AudioManager;
import android.content.Context;`
      );
    }

    config.modResults.contents = content;
    return config;
  });
};
