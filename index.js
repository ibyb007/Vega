import { AppRegistry } from 'react-native';
import { enableScreens } from 'react-native-screens';
import App from './src/App';

enableScreens(true);

AppRegistry.registerComponent('main', () => App);
