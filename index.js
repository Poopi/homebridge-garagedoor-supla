var http = require('https');
var Service, Characteristic;

const pollingStateName = 'pollingState'
const UpdateContext = {
  COMMAND: 'command',
  TIMEOUT: 'timeout',
  POLLING: 'polling'
};

const MS                    = 1000;
const DEFAULT_UPDATE_DELAY  = 15;
const DEFAULT_POLL_DELAY    = 2;
const DEFAULT_STATUS_DELAY  = 3;

module.exports = function (homebridge) {
  Service         = homebridge.hap.Service;
  Characteristic  = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-garagedoor-supla', 'SuplaGarageDoorOpener', GarageSuplaAccessory);
};

class GarageSuplaAccessory {

  constructor(log, config) {
    this.log                  = log;
    try {
      this.debug = JSON.parse(process.env.DEBUG)
    }
    catch(e){
      this.debug = false;
    }

    this.name                 = config.name;
    this.host                 = config.host;
    this.port                 = config.port;
    this.SerialNumber         = config.serial || '000 001';
    this.openCloseCommand     = config.open_close;
    this.closeStateCommand    = config.close_state;

    this.openStateCommand     = (config.open_state && config.open_state.code) ? config.open_state : null;
    this.statusUpdateDelay    = (config.status_update_delay || DEFAULT_UPDATE_DELAY) * MS;
    this.pollStateDelay       = (config.poll_state_delay    || DEFAULT_POLL_DELAY) * MS;
    this.checkCmdStatusDelay  = (config.check_cmd_delay     || DEFAULT_STATUS_DELAY) * MS;

    this.curState             = Characteristic.CurrentDoorState.CLOSED;
    this.curTarget            = Characteristic.TargetDoorState.CLOSED;
  }

  httpRequest(hostname, port, req_opt, callback) {
    var accessory = this;
    var body      = JSON.stringify({
      'code':   req_opt.code,
      'action': req_opt.action
    });
    const req = http.request({
      hostname: hostname,
      port: port,
      method: 'PATCH',
      path: req_opt.path,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    }, (res) => {
      var chunks = []
      res.on('data', (chunk) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        let res_body = Buffer.concat(chunks);
        callback(null, res.statusCode, res_body.toString());
      });
    });
    //accessory.log('Command to run: ' + req_opt.path + ' ' + body);
    req.write(body);
    req.on('error', (e) => {
      accessory.log("Command function failed: %s", e.message);
      callback(e);
    });
    req.end();
  }

  descState(state) {
    switch (state) {
      case Characteristic.CurrentDoorState.OPEN:
        return 'Open';
      case Characteristic.CurrentDoorState.CLOSED:
        return 'Closed';
      case Characteristic.CurrentDoorState.STOPPED:
        return 'Stopped';
      case Characteristic.CurrentDoorState.OPENING:
        return 'Opening';
      case Characteristic.CurrentDoorState.CLOSING:
        return 'Closing';
      default:
        return 'Unknown';
    }
  }

  descTargetState(state) {
    switch (state) {
      case Characteristic.TargetDoorState.OPEN:
        return 'Open';
      case Characteristic.TargetDoorState.CLOSED:
        return 'Closed';
      default:
        return 'Unknown';
    }
  }

  setTargetDoorState(isClosed, callback) {
    var accessory = this;
    var that = this;

    if (this.debug){
      accessory.log('setState:' + isClosed);
    }

    this.stopPollingDoorState();
    this.httpRequest(this.host, this.port, this.openCloseCommand, function (error, response, responseBody) {
      if (error) {
        accessory.log('Error: ' + error);
        callback(error || new Error('Error setting ' + accessory.name + ' to ' + state));
        //restart polling
        that.startPollingDoorState(false);
      } else {
        that.updatePosition(isClosed ? Characteristic.CurrentDoorState.CLOSING : Characteristic.CurrentDoorState.OPENING, UpdateContext.COMMAND);
        callback(null);
        that.startPollingDoorState(true);
      }
    });
  }

  updatePosition(state,context) {
    var accessory = this;

    let currentState = this.curState;
    let CHS   = Characteristic.CurrentDoorState;
    let CHTS  = Characteristic.TargetDoorState;

    if ((state === CHS.OPENING && currentState !== CHS.OPEN) ||
        (state === CHS.OPEN    /*&& currentState !== CHS.CLOSING*/) || 
        (state === CHS.CLOSING && currentState !== CHS.CLOSED) ||
        (state === CHS.CLOSED  /*&& currentState !== CHS.OPENING*/) ||
        (state === CHS.STOPPED)){
          currentState = state;
        }
        else if (state === null) {
          if (currentState === CHS.CLOSED) {
            currentState = CHS.OPENING;
          }
          else if (currentState === CHS.OPEN) {
            currentState = CHS.CLOSING;
          }
        }

    if((context != UpdateContext.POLLING || currentState != this.curState) && this.debug) {
      accessory.log('Update position (' + context + '-' + this.descState(state) + '): current - ' + this.descState(currentState) + ' vs ' + this.descState(this.curState));
    }
    if (currentState === this.curState) {
      return;
    }

    if (this.openStateCommand != null) {
      //This might only make sense if we do have 2 sensors
      if (context == UpdateContext.COMMAND) {
        clearTimeout(this.doorTimeout);
        if (currentState === CHS.CLOSING || currentState === CHS.OPENING) {
          this.doorTimeout = setTimeout(() => {
            this.updatePosition(CHS.STOPPED, UpdateContext.TIMEOUT);
          }, this.statusUpdateDelay);
        }
      }
    }

    if (currentState === CHS.OPENING || currentState === CHS.OPEN) {
      this.curTarget = CHTS.OPEN;
    }
    else if (currentState === CHS.CLOSING || currentState === CHS.CLOSED) {
      this.curTarget = CHTS.CLOSED;
    }

    this.curState = currentState;
    this.updateDoorState(this.curState, this.curTarget);
  }

  updateDoorState(currentState,targetState) {
    var accessory = this;

    if (this.debug) {
      accessory.log('Target door position:', this.descTargetState(targetState));
    }
    this.garageDoorService.updateCharacteristic(Characteristic.TargetDoorState, targetState);
    if (this.debug) {
      accessory.log('Current door state:', this.descState(currentState));
    }
    this.garageDoorService.updateCharacteristic(Characteristic.CurrentDoorState, currentState);
  }

  getStateFromSupla(callback) {
    var accessory     = this;
    var that          = this;

    const reportError = function (error) {
      accessory.log('Error: ' + error);
      callback(error || new Error('Error getting ' + accessory.name + ' state '));
    }

    const getSuplaState = (req_opt) => {
      return new Promise((resolve, reject) => {
        this.httpRequest(this.host, this.port, req_opt, function (error, response, responseBody) {
          if (error) {
            reject(error);
          }
          else {
            try {
              let result = JSON.parse(responseBody);
              resolve(result);
            } catch (error) {
              accessory.log("Error:" + error);
              reject(error);
            }
          }
        });
      })
    }

    if (that.openStateCommand == null){
      getSuplaState(this.closeStateCommand)
        .then(result => callback(null, result, null))
        .catch(err => reportError(err));
    }
    else {
      Promise.all([getSuplaState(this.closeStateCommand), getSuplaState(this.openStateCommand)])
        .then(results => callback(null, results[0], results[1]))
        .catch(err => reportError(err));
    }
  }

  getState(callback) {
    var accessory = this;
    var that = this;
    this.getStateFromSupla( function (error, close_state, open_state ){
      if (error) {
        accessory.log('Error: ' + error);
        callback(error || new Error('Error getting ' + accessory.name + ' state ', that.curState));
      }
      else {
        let CHS = Characteristic.CurrentDoorState;
        //accessory.log('Get state from supla:' + close_state + ' | ' + open_state);
        if (open_state != null) {
          if (close_state.connected == true && open_state.connected == true) {
              callback(null, close_state.hi ? CHS.CLOSED : (open_state.hi ? CHS.OPEN : null));
          }
          else{
            callback(null, that.curState);
          }
        }
        else {
          if(close_state.connected == true) {
            callback(null, close_state.hi ? CHS.CLOSED : CHS.OPEN);
          }
          else {
            callback(null, that.curState);
          }
        }
      }
    });
  }

  stopPollingDoorState(){
    // Clear any existing timer
    if (this.stateTimer) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
  }

  startPollingDoorState(isCommand) {
    var accessory = this;
    var that = this;

    if (accessory.pollStateDelay > 0){
      accessory.stopPollingDoorState();
      accessory.stateTimer = setTimeout(
        function () {
          accessory.getState(function (error, currentDeviceState) {
            that.startPollingDoorState(false);
            if (error) {
              accessory.log(error);
              return;
            }
            else {
              that.updatePosition(currentDeviceState,UpdateContext.POLLING);
            }
          })
        },
        isCommand ? this.checkCmdStatusDelay : this.pollStateDelay
      );
    }
    else {
      accessory.getState(function (error, currentDeviceState) {
        if (error) {
          accessory.log(error);
        }
        else {
          that.updatePosition(currentDeviceState, UpdateContext.POLLING);
        }
      })
    }
  }

  getServices() {
    this.informationService = new Service.AccessoryInformation();
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'GarageDoor Supla')
      .setCharacteristic(Characteristic.Model,        'Homebridge Plugin')
      .setCharacteristic(Characteristic.SerialNumber, this.SerialNumber);

    this.garageDoorService = new Service.GarageDoorOpener(this.name);
    this.garageDoorService.getCharacteristic(Characteristic.TargetDoorState)
      .on('set', this.setTargetDoorState.bind(this));

    this.updateDoorState(this.curState, this.curTarget);
    this.startPollingDoorState(false);
    return [this.informationService, this.garageDoorService];
  }

};


