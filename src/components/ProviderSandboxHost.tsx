import React, { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import useContentStore from '../lib/zustand/contentStore';
import { providerManager } from '../lib/services/ProviderManager';

export default function ProviderSandboxHost() {
  const webViewRef = useRef<WebView>(null);
  const provider = useContentStore((state) => state.provider);

  useEffect(() => {
    if (webViewRef.current && provider?.code) {
      providerManager.setWebViewBridge(webViewRef.current);
    }
  }, [provider]);

  return (
    <View pointerEvents="none" style={styles.hiddenContainer}>
      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{
          html: `
            <!DOCTYPE html>
            <html>
              <head><meta charset="utf-8"></head>
              <body>
                <script>
                  window.isVegaSandbox = true;
                </script>
              </body>
            </html>
          `,
        }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        onMessage={(event) => {
          try {
            providerManager.handleBridgeMessage(event.nativeEvent.data);
          } catch (e) {
            console.warn('[SandboxHost] Message dispatch error:', e);
          }
        }}
        style={styles.webView}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hiddenContainer: {
    position: 'absolute',
    top: -1000,
    left: -1000,
    width: 10,
    height: 10,
    opacity: 0.01,
  },
  webView: {
    width: 10,
    height: 10,
  },
});
