import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Berbeda dari aplikasi resmi di Play Store supaya keduanya bisa terpasang
  // berdampingan di satu HP; lihat catatan di android/app/build.gradle.
  appId: 'com.alfaris.freekasir',
  appName: 'FreeKasir',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1000,
      backgroundColor: '#FFFFFF',
      showSpinner: false,
    },
    StatusBar: {
      overlaysWebView: false,
      style: 'LIGHT',
      backgroundColor: '#0169ff',
    },
  },
};

export default config;
