import {Categories, CharacteristicSetCallback, CharacteristicValue, PlatformAccessory, Service} from 'homebridge';
import {TasmotaService} from './TasmotaService';
import {tasmotaPlatform} from './platform';
import os from 'os';
import {PLUGIN_NAME} from './settings';

import createDebug from 'debug';

const debug = createDebug('Tasmota:ir-tv-remote');

export interface TvConfig {
  'name': string;
  'identifier': string;
  'manufacturer': string;
  'model': string;
  'serial': string;
  'codeType': string;
  'codes': {
    'power': string;
    'volume': {
      'up': string;
      'down': string;
      'mute': string;
    };
    'keys': {
      'REWIND': string;
      'FAST_FORWARD': string;
      'NEXT_TRACK': string;
      'PREVIOUS_TRACK': string;
      'ARROW_UP': string;
      'ARROW_DOWN': string;
      'ARROW_LEFT': string;
      'ARROW_RIGHT': string;
      'SELECT': string;
      'BACK': string;
      'EXIT': string;
      'PLAY_PAUSE': string;
      'INFORMATION': string;
    };
  };
}

export class tasmotaIrTvRemoteService extends TasmotaService {
  private readonly televisionService: Service;
  private speakerService?: Service;
  private configuredRemoteKeys: number[] = [];
  private readonly deviceConfig: TvConfig;

  constructor(
      public readonly platform: tasmotaPlatform,
      public readonly accessory: PlatformAccessory,
      protected readonly uniq_id: string,
  ) {
    super(platform, accessory, uniq_id);

    accessory.category = Categories.TELEVISION;
    this.deviceConfig = accessory.context.device;

    this.televisionService =
        this.accessory.getService(this.uuid) ||
        this.accessory.addService(
          this.platform.Service.Television,
          accessory.context.device[this.uniq_id].name,
          this.uuid,
        );

    this.configureMetaCharacteristics();

    this.televisionService.updateCharacteristic(this.platform.Characteristic.Active, false);

    this.televisionService.getCharacteristic(this.platform.Characteristic.Active)
      .on('set', this.onPowerTogglePress.bind(this));

    this.televisionService
      .getCharacteristic(this.platform.Characteristic.ActiveIdentifier)!
      .on('set', this.onActiveIdentifierSet.bind(this));

    this.configureRemoteKeys();

    if (this.deviceConfig.codes.volume.up && this.deviceConfig.codes.volume.down) {
      this.configureVolumeKeys();
    }
  }

  private configureMetaCharacteristics() {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        this.deviceConfig.manufacturer || 'Default-Manufacturer',
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.deviceConfig.model || 'Default-Model',
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.deviceConfig.serial|| 'Default-Serial',
      );

    this.televisionService
      .setCharacteristic(this.platform.Characteristic.ActiveIdentifier, 1);

    this.televisionService.setCharacteristic(
      this.platform.Characteristic.ConfiguredName,
      this.deviceConfig.name,
    );

    this.televisionService.setCharacteristic(
      this.platform.Characteristic.SleepDiscoveryMode,
      this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
    );

    this.televisionService.setCharacteristic(
      this.platform.Characteristic.Name,
      this.deviceConfig.name,
    );
  }

  private sendIrCommand(code: string) {
    const command = `cmnd/tasmota_${this.deviceConfig.identifier.toUpperCase()}/IRsend`;
    this.accessory.context.mqttHost.sendMessage(command, JSON.stringify({
      Protocol: this.deviceConfig.codeType,
      Bits: 32,
      Data: code,
    }));
  }

  private onPowerTogglePress(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.platform.log.debug('Send POWER Command', value);

    this.sendIrCommand(this.deviceConfig.codes.power);
    callback(null);
  }

  private onActiveIdentifierSet(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.platform.log.debug('set Active Identifier => setNewValue: ' + value);
    callback(null);
  }

  private configureRemoteKeys() {
    this.televisionService.getCharacteristic(this.platform.Characteristic.RemoteKey)
      .on('set', this.onRemoteKeyPress.bind(this));

    const configuredRemoteKeyStrings = this.deviceConfig.codes.keys ? Object.keys(this.deviceConfig.codes.keys) : [];
    configuredRemoteKeyStrings.forEach(key => {
      this.platform.log.debug('Configuring Remote-Key: ' + key);
      this.configuredRemoteKeys.push(
        (this.platform.Characteristic.RemoteKey as unknown as { [key: string]: number })[key],
      );
    });
  }

  private onRemoteKeyPress(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.platform.log.debug('Remote Key Pressed ' + value);

    if (
      !this.deviceConfig.codes.keys ||
        !this.configuredRemoteKeys.find((item) => item === value)
    ) {
      this.platform.log.error(`Remote Key ${value} not configured in this.configuredRemoteKeys`);
      this.platform.log.debug(JSON.stringify(this.configuredRemoteKeys, null, 4));
      callback(new Error(`Remote-Key "${value}" not configured`));
      return;
    }

    let irCode = '';
    Object.keys(this.platform.Characteristic.RemoteKey as unknown as { [key: string]: number }).forEach(
      (keyOfRemoteKeyObject) => {
        if (this.platform.Characteristic.RemoteKey[keyOfRemoteKeyObject] === value) {
          this.platform.log.debug(`Remote-Key ${value} maps to ${keyOfRemoteKeyObject}`);
          irCode = this.deviceConfig.codes.keys[keyOfRemoteKeyObject];
        }
      },
    );

    if (!irCode) {
      this.platform.log.debug(JSON.stringify(Object.keys(this.platform.Characteristic.RemoteKey), null, 4));
      this.platform.log.error(`Remote Key ${value} not configured`);
      callback(new Error(`Remote-Key ${value} not configured`));
      return;
    }

    this.sendIrCommand(irCode);

    callback(null);
  }

  private configureVolumeKeys() {
    this.platform.log.debug('Adding speaker service');
    this.speakerService =
        this.accessory.getService(this.platform.Service.TelevisionSpeaker) ||
        this.accessory.addService(this.platform.Service.TelevisionSpeaker);

    // set the volume control type
    this.speakerService
      .setCharacteristic(
        this.platform.Characteristic.Active,
        this.platform.Characteristic.Active.ACTIVE,
      )
      .setCharacteristic(
        this.platform.Characteristic.VolumeControlType,
        this.platform.Characteristic.VolumeControlType.ABSOLUTE,
      );

    if (this.deviceConfig.codes.volume.mute) {
      this.speakerService
        .getCharacteristic(this.platform.Characteristic.Mute)
        .on('set', this.setMute.bind(this));
    }

    this.speakerService
      .getCharacteristic(this.platform.Characteristic.VolumeSelector)
      .on('set', this.setVolume.bind(this));

    // Link the service
    this.televisionService.addLinkedService(this.speakerService);
  }

  private setMute(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ): void {
    this.platform.log.debug('setMute called with: ' + value);
    this.sendIrCommand(this.deviceConfig.codes.volume.mute);
    callback(null);
  }

  private setVolume(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ): void {
    this.platform.log.debug('setVolume called with: ' + value);

    let irCode = this.deviceConfig.codes.volume.up;
    if (value === this.platform.Characteristic.VolumeSelector.DECREMENT) {
      irCode = this.deviceConfig.codes.volume.down;
    }

    this.sendIrCommand(irCode);

    callback(null);
  }
}
