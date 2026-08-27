const {withGradleProperties} = require('expo/config-plugins');

const GRADLE_PROPERTIES = {
  // Dedicated 4GB heap allocation with G1GC and increased Metaspace
  'org.gradle.jvmargs': '-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+UseG1GC',
  // Limit concurrent workers to prevent RAM spikes on GitHub Actions runners
  'org.gradle.workers.max': '2',
  // Bound Kotlin compiler daemon memory
  'kotlin.daemon.jvmargs': '-Xmx2048m',
};

function upsertProperty(modResults, key, value) {
  const existing = modResults.find(
    item => item.type === 'property' && item.key === key,
  );
  if (existing) {
    existing.value = value;
  } else {
    modResults.push({type: 'property', key, value});
  }
}

module.exports = function withJvmArgs(config) {
  return withGradleProperties(config, cfg => {
    for (const [key, value] of Object.entries(GRADLE_PROPERTIES)) {
      upsertProperty(cfg.modResults, key, value);
    }
    return cfg;
  });
};
