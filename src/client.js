"use strict";

const EventEmitter = require("events");
const net = require("net");
const http = require("https");
const compareVersions = require('compare-versions');
const { requireFromAppRoot } = require('require-from-app-root');
const pluginVersion = requireFromAppRoot('package.json').version;

const SOCKET_IP = '127.0.0.1';
const SOCKET_PORT = 12136;

class TouchPortalClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.touchPortal = null;
    this.pluginId = null;
    this.socket = null;
    this.customStates = {};
  }

  createState(id, desc, defaultValue) {
    if (this.customStates[id]) {
      this.logIt("ERROR",`createState: Custom state of ${id} already created`);
      throw new Error(`createState: Custom state of ${id} already created`);
    }
    this.send({
      type: "createState",
      id: id,
      desc: desc,
      defaultValue: defaultValue,
    });
  }

  choiceUpdate(id, value) {
    if (value.length <= 0) {
      this.logIt( "ERROR","choiceUpdate: value is an empty array");
      throw new Error("choiceUpdate: value is an empty array");
    }
    this.send({ type: "choiceUpdate", id: id, value: value });
  }

  choiceUpdateSpecific(id, value, instanceId) {
    if (value.length <= 0) {
      this.logIt("ERROR","choiceUpdateSpecific : value does not contain data in an array format");
      throw new Error(
        "choiceUpdateSpecific: value does not contain data in an array format"
      );
    }
    if (!instanceId || instanceId == "") {
      this.logIt("ERROR","choiceUpdateSpecific : instanceId is not populated");
      throw new Error("choiceUpdateSpecific: instanceId is not populated");
    }
    this.send({
      type: "choiceUpdate",
      id: id,
      instanceId: instanceId,
      value: value,
    });
  }

  settingUpdate(name,value){
    this.send({
      type: "settingUpdate",
      name: name,
      value: value
    });
  }

  stateUpdate(id, value) {
    this.send({ type: "stateUpdate", id: `${id}`, value: `${value}` });
  }

  stateUpdateMany(states) {
    let stateArray = [];

    if (states.length <= 0) {
      this.logIt("ERROR","stateUpdateMany : states contains no data");
      throw new Error("stateUpdateMany: states contains no data");
    }

    states.forEach((state) => {
      stateArray.push({
        type: "stateUpdate",
        id: `${state.id}`,
        value: `${state.value}`,
      });
    });

    this.sendArray(stateArray);
  }

  sendArray(dataArray) {
    let dataStr = "";
    if (dataArray.length <= 0) {
      this.logIt("ERROR","sendArray : dataArray has no length");
      throw new Error("sendArray: dataArray has no length");
    }
    dataArray.forEach((element) => {
      dataStr = dataStr + JSON.stringify(element) + "\n";
    });

    if (dataStr == null) {
      return;
    }

    this.socket.write(dataStr);
  }

  send(data) {
    this.socket.write(JSON.stringify(data) + "\n");
  }

  pair() {
    const pairMsg = {
      type: "pair",
      id: this.pluginId,
    };
    this.send(pairMsg);
  }

  checkForUpdate() {
		const parent = this;
		http.get(this.updateUrl, (res) => {
			const { statusCode } = res;

			let error;
			// Any 2xx status code signals a successful response but
			// here we're only checking for 200.
			if (statusCode !== 200) {
				error = new Error(this.pluginId + ':ERROR: Request Failed.\n' + `Status Code: ${statusCode}`);
			}
			if (error) {
				parent.logIt("ERROR",`check for update errored: ${error.message}`);
				res.resume();
				return;
			}

			res.setEncoding('utf8');
			let updateData = '';
			res.on('data', (chunk) => {
				updateData += chunk;
			});
			res.on('end', () => {
				try {
					const jsonData = JSON.parse(updateData);
					if (jsonData.version !== null) {
						if (compareVersions(jsonData.version, pluginVersion) > 0) {
							parent.emit('Update', pluginVersion, jsonData.version);
						}
					}
				}
				catch (e) {
					parent.logIt("ERROR: Check for Update error=",e.message);
				}
			});
		});
	}

  connect(options = {}) {
    let { pluginId, updateUrl } = options;
    this.pluginId = pluginId;
    let parent = this;

    if ( updateUrl !== undefined ) {
		  this.updateUrl = updateUrl;
			this.checkForUpdate();
		}

    this.socket = new net.Socket();
    this.socket.setEncoding("utf-8");
    this.socket.connect(SOCKET_PORT, SOCKET_IP, function () {
      parent.logIt("INFO","Connected to TouchPortal");
      parent.emit("connected");
      parent.pair();
    });

    this.socket.on("data", function (data) {

      let lines = data.split(/(?:\r\n|\r|\n)/);

      lines.forEach( (line) => {
        if( line == '' ) { return };
        const message = JSON.parse(line);

        //Handle internal TP Messages here, else pass to user code
        switch (message.type) {
          case "closePlugin":
            if (message.pluginId === parent.pluginId) {
              parent.emit("Close", message);
              parent.logIt("WARN","received Close Plugin message");
              parent.socket.end();
              process.exit(0);
            }
            break;
          case "info":
            parent.logIt("DEBUG","Info Message received");
            parent.emit("Info", message);
            if( message["settings"] ) {
                parent.emit("Settings", message.settings)
            }
            break;
          case "settings":
            parent.logIt("DEBUG","Settings Message received");
            // values is the key that is the same as how info contains settings key, for direct settings saving
            parent.emit("Settings", message.values);
            break;
          case "listChange":
            parent.logIt("DEBUG","ListChange Message received");
            parent.emit("ListChange", message);
            break;
          case "action":
            parent.logIt("DEBUG","Action Message received");
            parent.emit("Action", message, null);
            break;
          case "broadcast":
            parent.logIt("DEBUG","Broadcast Message received");
            parent.emit("Broadcast", message);
            break;
          case "up":
            parent.logIt("DEBUG","Up Hold Message received");
            parent.emit("Action", message, false);
            break;
          case "down":
            parent.logIt("DEBUG","Down Hold Message received");
            parent.emit("Action", message, true);
            break;
          default:
            parent.logIt("DEBUG",`Unhandled type received ${message.type}`);
            parent.emit("Message", message);
        }
      });
    });
    this.socket.on("error", function () {
      parent.logIt("ERROR","Socket Connection closed");
      process.exit(0);
    });

    this.socket.on("close", function () {
      parent.logIt("WARN","Connection closed");
    });
  }
  logIt() {
    var curTime = new Date().toISOString();
    var message = [...arguments];
    var type = message.shift();
    console.log(curTime,":",this.pluginId,":"+type+":",message.join(" "));
  }
}

module.exports = TouchPortalClient;
