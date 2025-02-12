/* global log*/

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Config = imports.misc.config;
const Clutter = imports.gi.Clutter;
const Gettext = imports.gettext.domain('gnome-shell-extension-mycroft');
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const GLib = imports.gi.GLib;
const Gvc = imports.gi.Gvc;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Soup = imports.gi.Soup;
const St = imports.gi.St;
const GnomeSession = imports.misc.gnomeSession;
const Util = imports.misc.util;
const Convenience = Me.imports.convenience;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;
const Pango = imports.gi.Pango;
const Tweener = imports.tweener.tweener;
const EXTENSIONDIR = Me.dir.get_path();
const GObject = imports.gi.GObject
const ByteArray = imports.byteArray;

const MYCROFT_SETTINGS_SCHEMA = 'org.gnome.shell.extensions.mycroft';
const MYCROFT_POSITION_IN_PANEL_KEY = 'position-in-panel';
const MYCROFT_CORE_LOCATION_KEY = 'mycroft-core-location';
const MYCROFT_IS_INSTALL_KEY = 'mycroft-is-install';
const MYCROFT_INSTALL_TYPE_KEY = 'mycroft-install-type';
const MYCROFT_IP_ADDRESS_KEY = 'mycroft-ip-address';
const MYCROFT_PORT_NUMBER_KEY = 'mycroft-port-number';
const MYCROFT_ANIMATION_STATUS_KEY = 'animation-status';

// let _httpSession;
let _timeoutId,
  miPanel,
  socketClient,
  _mixerControl,
  core_location,
  mycroft_is_install,
  position_in_panel,
  install_type,
  animation_status;

const MycroftPosition = {
  CENTER: 0,
  RIGHT: 1,
  LEFT: 2,
};

function getMixerControl() {
  if (_mixerControl) {
    return _mixerControl;
  }

  _mixerControl = new Gvc.MixerControl({
    name: 'Mycroft Input Control',
  });
  _mixerControl.open();

  return _mixerControl;
}

const MycroftServiceManager = GObject.registerClass(
  {
    GTypeName: 'MycroftServiceManager',
    Signals: {
      'mycroft-service-clicked': {},
      'send-message': {
        param_types: [GObject.TYPE_STRING],
      },
      'mycroft-animation-start':{
        param_types: [GObject.TYPE_STRING],
      },
      'mycroft-animation-stop': {
        param_types: [GObject.TYPE_STRING],
      },
      'mycroft-status': {
        param_types: [GObject.TYPE_STRING],
      },
      'settings-changed': {},
      'message-recieved': {
        param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
      },
    },
  }, class MycroftServiceManager extends PopupMenu.PopupBaseMenuItem{
    constructor() {
      super();
      this.wsStarted = false;
      this.loadConfig();
      const msm = this;
      position_in_panel = this._position_in_panel;
      core_location = this.core_location;
      mycroft_is_install = this.mycroft_is_install;
      install_type = this.install_type;
      animation_status = this.animation_status;
      this.setEventListeners();
      if (mycroft_is_install) {
        this.emitServiceStatus('install');
      }
      _timeoutId = Mainloop.timeout_add(2000, Lang.bind(this, function () {
        this.getServiceStatus(Lang.bind(this, function (status) {
          if (status === 'active') {
            this.emitServiceStatus('starting');
            if (_timeoutId !== 0) {
              Mainloop.source_remove(_timeoutId);
            }
            _timeoutId = Mainloop.timeout_add(1000, Lang.bind(this, function () {
              msm.initWS();
              _timeoutId = 0;
            }));
          } else if (status === 'disabled' || status === 'failed') {
            this.emitServiceStatus('disabled');
          } else if (status === 'install') {
          // do nothing
          } else if (status === 'remote') {
            this.emitServiceStatus('starting');
            _timeoutId = Mainloop.timeout_add(6000, Lang.bind(this, function () {
              msm.initWS();
              _timeoutId = 0;
            }));
          }
        }));
        _timeoutId = 0;
      }));    
    }
    setEventListeners() {
      this.serviceClicked = this.connect(
        'mycroft-service-clicked',
        Lang.bind(this, function () {
          if (!this.locked) {
            this.locked = true;
            this.initWS();
            this.getServiceStatus(
              Lang.bind(this, function (status) {
                if (status === 'active' || status === 'listening') {
                  this.stopService();
                } else if (status === 'disabled' || status === 'failed') {
                  this.startService();
                } else if (status === 'install') {
                  // do nothing;
                } else if (status === 'remote') {
                  if (!this.wsStarted) {
                    this.emitServiceStatus('starting');
                    _timeoutId = Mainloop.timeout_add(
                      8000,
                      Lang.bind(this, function () {
                        this.initWS();
                        _timeoutId = 0;
                      })
                    );
                  } else {
                    this.emitServiceStatus('disabled');
                    this.closeSocket();
                  }
                }
              })
            );
          } else {
            // locked
            log('locked.');
          }
        })
      );
      this.sendMessageId = this.connect(
        'send-message',
        Lang.bind(this, function (uploader, message) {
          this.sendMessage(message);
        })
      );
    }
    startService() {
      if (_timeoutId !== 0) {
        Mainloop.source_remove(_timeoutId);
      }
      this.getServiceStatus(
        Lang.bind(this, function (status) {
          if (status === 'disabled' || status === 'failed') {
            try {
              GLib.spawn_command_line_async(
                core_location + '/start-mycroft.sh all'
              );
              this.emitServiceStatus('starting');
              _timeoutId = Mainloop.timeout_add(
                5000,
                Lang.bind(this, function () {
                  this.getServiceStatus(
                    Lang.bind(this, function (status) {
                      if (status === 'active') {
                        _timeoutId = Mainloop.timeout_add(
                          5000,
                          Lang.bind(this, function () {
                            this.initWS();
                          })
                        );
                      }
                    })
                  );
                  _timeoutId = 0;
                })
              );
            } catch (e) {
              log('Mycroft UI - Start Service' + e);
            }
          }
        })
      );
    }
    stopService(callback) {
      this.emitServiceStatus('stopping');
      try {
        GLib.spawn_command_line_async(core_location + '/stop-mycroft.sh');
        this.closeSocket();
        this.wsStarted = false;
      } catch (e) {
        log('Mycroft UI - Stop Service' + e);
      }
      this.emitServiceStatus('disabled');
    }
    getServiceStatus(callback) {
      let e, outStr;
      if (mycroft_is_install && install_type != 2) {
        try {
          let [ res, out, standard_error, exit_status ] = GLib.spawn_command_line_sync(EXTENSIONDIR + '/shellscripts/serviceStatus.sh');
          log(ByteArray.toString(out), exit_status);
          if (out.length > 1) {
            // outStr = out.toString();
            if (
              !exit_status
            ) {
              if (this.wsStarted) {
                this.emitServiceStatus('active');
              } else {
                this.emitServiceStatus('starting');
              }
              callback('active');
            } else {
              callback('disabled');
            }
          } else {
            callback('disabled');
          }
        } catch (err) {
          log('Mycroft UI - Get Service Status' + err);
        }
      } else if (install_type == 2) {
        callback('remote');
      } else {
        this.emitServiceStatus('install');
        callback('install');
      }
    }
    initWS() {
      this.user_agent = Me.metadata.uuid;
      if (
        Me.metadata.version !== undefined &&
        Me.metadata.version.toString().trim() !== ''
      ) {
        this.user_agent += '/';
        this.user_agent += Me.metadata.version.toString();
      }
      this.user_agent += ' ';
      if (!this.wsStarted && mycroft_is_install) {
        // if (socketClient === undefined) {
        //  socketClient = new Soup.Session();
        //  socketClient.user_agent = this.user_agent;
        // } else {
        //  // abort previous requests.
        //  socketClient.abort();
        //  socketClient = new Soup.Session();
        // }
        // let proxy = new Soup.ProxyResolverDefault();
        // Soup.Session.prototype.add_feature.call(socketClient, proxy);
  
        socketClient.httpsAliases = [ 'wss' ];
        let message = new Soup.Message({
          method: 'GET',
          uri: new Soup.URI(
            'ws://' + this.ip_address + ':' + this.port_number + '/core'
          ),
        });
        try {
          socketClient.websocket_connect_async(
            message,
            null,
            null,
            null,
            Lang.bind(this, function (session, result) {
              try {
                this.connection = session.websocket_connect_finish(result);
                if (this.connection !== null) {
                  this.connection.connect(
                    'message',
                    Lang.bind(this, this.onMessage)
                  );
  
                  this.connection.connect(
                    'closed',
                    Lang.bind(this, function (connection) {
                      this.onClosed(connection);
                    })
                  );
  
                  this.wsStarted = true;
                }
              } catch (e) {
                if (this.install_type == 2) {
                  this.emitServiceStatus('remote-error');
                }
                this.emitServiceStatus('failed');
              }
            })
          );
        } catch (e) {
          log('Mycroft UI - Init Websocket' + e);
        }
      }
      this.locked = false;
    }
    onMessage(connection, type, message) {
      let data = JSON.parse(message.get_data());
      if (data.type === 'connected') {
        this.emitServiceStatus('active'); // Active();
      } else if (data.type === 'speak') {
        this.emit('message-recieved', data.data.utterance, 'mycroft');
      } else if (data.type === 'mycroft.not.paired') {
        //
      } else if (data.type === 'recognizer_loop:audio_output_start') {
        this.emitAnimationStatus('audio_output_start');
      } else if (data.type === 'recognizer_loop:audio_output_end') {
        this.emitAnimationStatus('audio_output_stop');
      } else if (data.type === 'enclosure.weather.display') {
        // log('show Weather Panel');
      } else if (data.type === 'configuration.updated') {
        this.wsStarted = true;
      } else if (data.type === 'recognizer_loop:record_begin') {
        this.emitServiceStatus('listening');
      } else if (data.type === 'recognizer_loop:record_end') {
        this.emitServiceStatus('active');
      } else if (data.type === 'configuration.updated') {
        // later
      } else if (data.type === 'recognizer_loop:utterance') {
        this.emit('message-recieved', data.data.utterances[0], 'me');
      } else if (data.type === 'intent_failure') {
        // this.emit('message-recieved', 'Sorry I didn\'t understand you. Please rephrase or ask another question','mycroft');
      }
    }
    onClosing(connection) {}
    onClosed(connection) {
      this.wsStarted = false;
      // connection.close(Soup.WebsocketCloseCode.NORMAL, "");
      if (_timeoutId !== 0) {
        Mainloop.source_remove(_timeoutId);
      }
  
      _timeoutId = Mainloop.timeout_add(
        6000,
        Lang.bind(this, function () {
          this.getServiceStatus(
            Lang.bind(this, function (status) {
              if (status === 'active') {
                _timeoutId = Mainloop.timeout_add(
                  4000,
                  Lang.bind(this, function () {
                    this.initWS();
                  })
                );
              } else if (status === 'disabled' || status === 'remote') {
                if (socketClient !== undefined) {
                  socketClient.abort();
                }
              }
            })
          );
          _timeoutId = 0;
        })
      );
  
      // socketClient.abort();
    }
    onError(connection, error) {
      log('Mycroft UI - Connection Error : ' + error);
    }
    sendMessage(val) {
      if (this.wsStarted) {
        let socketmessage = {};
        socketmessage.type = 'recognizer_loop:utterance';
        socketmessage.data = {};
        socketmessage.data.utterances = [ val ];
        try {
          this.connection.send_text(JSON.stringify(socketmessage));
        } catch (e) {
          log('Mycroft UI - Send Message: ' + e);
        }
      } else {
        log('Mycroft UI - No web socket');
      }
    }
    closeSocket() {
      try {
        if (this.connection) {
          this.connection.close(Soup.WebsocketCloseCode.NORMAL, '');
        }
        if (socketClient) {
          socketClient.abort();
        }
      } catch (e) {
        log('Mycroft UI - Close Socket: ' + e);
      }
    }
    emitServiceStatus(status, arg) {
      if (status === 'starting' || status === 'stopping') {
        this.locked = true;
      } else {
        this.locked = false;
      }
      this.emitAnimationStatus(status);
      this.emit('mycroft-status', status);
    }
    emitAnimationStatus(status) {
      if (status === 'audio_output_start') {
        this.emit('mycroft-animation-start', 'active');
      } else if (status === 'audio_output_stop') {
        this.emit('mycroft-animation-stop', 'active');
      } else if (
        status === 'starting' ||
        status === 'stopping' ||
        status === 'listening'
      ) {
        this.emit('mycroft-animation-start', status);
      } else {
        this.emit('mycroft-animation-stop', status);
      }
    }
    destroy() {
      if (this._settingsC) {
        this._settings.disconnect(this._settingsC);
        this._settingsC = undefined;
      }
      if (this.serviceClicked) {
        this.disconnect(this.serviceClicked);
        this.serviceClicked = 0;
      }
      if (this.sendMessageId) {
        this.disconnect(this.sendMessageId);
        this.sendMessageId = 0;
      }
    }
    loadConfig() {
      this._settings = Convenience.getSettings(MYCROFT_SETTINGS_SCHEMA);
      mycroft_is_install = this.mycroft_is_install;
      install_type = this.mycroft_install_type;
      if (this._settingsC) {
        this._settings.disconnect(this._settingsC);
      }
      this._settingsC = this._settings.connect(
        'changed',
        Lang.bind(this, function () {
          position_in_panel = this._position_in_panel;
          core_location = this.core_location;
          animation_status = this.animation_status;
          let mycroft_is_install_change = this.mycroft_is_install;
          let install_type_change = this.install_type;
          this.emit('settings-changed');
          if (mycroft_is_install !== mycroft_is_install_change) {
            mycroft_is_install = this.mycroft_is_install;
            this.emitServiceStatus('disabled');
          } else if (mycroft_is_install_change === false) {
            if (this.wsStarted) {
              this.stopService();
            }
            this.emitServiceStatus('install');
          }
          if (install_type !== install_type_change) {
            install_type = this.install_type;
            if (install_type == 2) {
              this.emitServiceStatus('disabled');
              if (this.wsStarted) {
                this.closeSocket();
              }
            }
          }
        })
      );
    }
    get mycroft_is_install() {
      if (!this._settings) {
        this.loadConfig();
      }
      return this._settings.get_boolean(MYCROFT_IS_INSTALL_KEY);
    }
    get _position_in_panel() {
      if (!this._settings) {
        this.loadConfig();
      }
      return this._settings.get_enum(MYCROFT_POSITION_IN_PANEL_KEY);
    }
    get core_location() {
      if (!this._settings) {
        this.loadConfig();
      }
      return this._settings.get_string(MYCROFT_CORE_LOCATION_KEY);
    }
    get install_type() {
      if (!this._settings) {
        this.loadConfig();
      }
      return this._settings.get_int(MYCROFT_INSTALL_TYPE_KEY);
    }
    get animation_status() {
      if (!this._settings) {
        this.loadConfig();
      }
      return this._settings.get_boolean(MYCROFT_ANIMATION_STATUS_KEY);
    }
    get ip_address() {
      if (!this._settings) {
        this.loadConfig();
      }
      return this._settings.get_string(MYCROFT_IP_ADDRESS_KEY);
    }
    get port_number() {
      if (!this._settings) {
        this.loadConfig();
      }
      return this._settings.get_string(MYCROFT_PORT_NUMBER_KEY);
    }
  }
);


const MycroftUI = GObject.registerClass({
  GTypeName: 'MycroftUI',
  Signals: {
    'mycroft-service-clicked': {}
  }
}, class MycroftUI extends GObject.Object{
  constructor() {
    super();
    this.mycroftService = new MycroftServiceManager();

    this.mycroftPanel = new MycroftPanelButton();
   


    this.myUi = new MycroftPopup();
    this.setEventListeners();

    this.mycroftPanel.menu.addMenuItem(this.myUi.popupMenuMain);

    this.myUi.core_location = this.mycroftPanel.core_location;

    Main.panel.addToStatusArea('mycroftAi', this.mycroftPanel, 1);

    applyStyles();
  }
  setEventListeners() {
    // Service Status Connect
    
    this.mycroftServiceSettingsChangedId = this.mycroftService.connect(
      'settings-changed', (uploader) => {
        this.mycroftPanel.checkPositionInPanel();
      });
      
    this.mycroftServiceStatusId = this.mycroftService.connect(
      'mycroft-status',
      Lang.bind(this, this.updateStatus)
    );
    
    this.myUiTopMenuBarServiceActorClickId = this.myUi.topMenuBar.serviceActor.connect(
      'clicked',
      Lang.bind(this.mycroftService, function () {
        this.emit('mycroft-service-clicked');
      })
    );
    
    this.mycroftServiceMycroftAnimationStartId = this.mycroftService.connect(
      'mycroft-animation-start',
      Lang.bind(
        this.myUi.displayBox.searchBox.barAnimation,
        this.myUi.displayBox.searchBox.barAnimation.startAnimation
      )
    );
    
    this.mycroftServiceMycroftAnimationStopId = this.mycroftService.connect(
      'mycroft-animation-stop',
      Lang.bind(
        this.myUi.displayBox.searchBox.barAnimation,
        this.myUi.displayBox.searchBox.barAnimation.stopAnimation
      )
    );
    
    this.myUiDisplayBoxSearchBoxChatBoxSendMessageId = this.myUi.displayBox.searchBox.chatBox.connect(
      'send-message',
      Lang.bind(this, function (uploader, message) {
        this.mycroftService.emit('send-message', message);
      })
    );
    
    this.myUiTopMenuBarHintActorClickedId = this.myUi.topMenuBar.hintActor.connect(
      'clicked',
      Lang.bind(this.myUi.displayBox, this.myUi.displayBox.showPage)
    );
    
    this.myUiTopMenuBarSearchActorClickedId = this.myUi.topMenuBar.searchActor.connect(
      'clicked',
      Lang.bind(this.myUi.displayBox, this.myUi.displayBox.showPage)
    );

    this.mycroftServiceMessageRecievedId = this.mycroftService.connect(
      'message-recieved',
      Lang.bind(
        this.myUi.displayBox.searchBox.conversationBox,
        this.myUi.displayBox.searchBox.conversationBox.addMessage
      )
    );
    
    this.myUiTopMenuBarSettingsActorClickedId = this.myUi.topMenuBar.settingsActor.connect(
      'clicked',
      Lang.bind(this.mycroftPanel, function () {
        this.menu.actor.hide();
        Util.spawn([ 'gnome-shell-extension-prefs', 'mycroft@rahul.io' ]);
        return 0;
      })
    );
  }
  updateStatus(uploader, status) {
    this.myUi.displayBox.searchBox.updateStatus(status);
    status = status == 'remote-error' ? 'failed' : status;
    this.mycroftPanel.updatePanelIcon(status);
    this.myUi.topMenuBar.emit('mycroft-status', status);
  }
  destroy() {
    this.destroySignals();
    this.myUi.destroy();
    this.myUi = null;
    this.mycroftService.destroy();
    this.mycroftService.closeSocket();
    this.mycroftService = null;
    this.mycroftPanel.destroy();
    this.mycroftPanel = null;
  }
  destroySignals() {
    if (this.mycroftServiceSettingsChangedId) {
      this.mycroftService.disconnect(this.mycroftServiceSettingsChangedId);
      this.mycroftServiceSettingsChangedId = 0;
    }
    if (this.mycroftServiceStatusId) {
      this.mycroftService.disconnect(this.mycroftServiceStatusId);
      this.mycroftServiceStatusId = 0;
    }
    if (this.myUiTopMenuBarServiceActorClickId) {
      this.myUi.topMenuBar.serviceActor.disconnect(
        this.myUiTopMenuBarServiceActorClickId
      );
      this.myUiTopMenuBarServiceActorClickId = 0;
    }
    if (this.mycroftServiceMycroftAnimationStartId) {
      this.mycroftService.disconnect(
        this.mycroftServiceMycroftAnimationStartId
      );
      this.mycroftServiceMycroftAnimationStartId = 0;
    }
    if (this.mycroftServiceMycroftAnimationStopId) {
      this.mycroftService.disconnect(this.mycroftServiceMycroftAnimationStopId);
      this.mycroftServiceMycroftAnimationStopId = 0;
    }
    if (this.myUiDisplayBoxSearchBoxChatBoxSendMessageId) {
      this.myUi.displayBox.searchBox.chatBox.disconnect(
        this.myUiDisplayBoxSearchBoxChatBoxSendMessageId
      );
      this.myUiDisplayBoxSearchBoxChatBoxSendMessageId = 0;
    }
    if (this.myUiTopMenuBarHintActorClickedId) {
      this.myUi.topMenuBar.hintActor.disconnect(
        this.myUiTopMenuBarHintActorClickedId
      );
      this.myUiTopMenuBarHintActorClickedId = 0;
    }
    if (this.myUiTopMenuBarSearchActorClickedId) {
      this.myUi.topMenuBar.searchActor.disconnect(
        this.myUiTopMenuBarSearchActorClickedId
      );
      this.myUiTopMenuBarSearchActorClickedId = 0;
    }
    if (this.mycroftServiceMessageRecievedId) {
      this.mycroftService.disconnect(this.mycroftServiceMessageRecievedId);
      this.mycroftServiceMessageRecievedId = 0;
    }
    if (this.myUiTopMenuBarSettingsActorClickedId) {
      this.myUi.topMenuBar.settingsActor.disconnect(
        this.myUiTopMenuBarSettingsActorClickedId
      );
      this.myUiTopMenuBarSettingsActorClickedId = 0;
    }
  }
});

const MycroftPanelButton = GObject.registerClass({
    GTypeName: 'MycroftPanelButton'
  }, class MycroftPanelButton extends PanelMenu.Button{
  constructor() {
    let menuAlignment = 1.0 - 50 / 100; // 50 is location
    if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL) {
      menuAlignment = 1.0 - menuAlignment;
    }
    super(0);   
    this._position_in_panel = position_in_panel;

    let gicon = Gio.icon_new_for_string(Me.path + '/icons/mycroftLogo.svg');
    this._mycroftIcon = new St.Icon({
      gicon: gicon,
      style_class: 'system-status-icon mycroft-icon',
    });    

    // Putting the Panel Item together
    let topBox = new St.BoxLayout();
    topBox.add(this._mycroftIcon);
    this.add_child(topBox);

    //Not sure what this does
    //let dummyBox = new St.BoxLayout();
    //this.actor.reparent(dummyBox);
    //dummyBox.remove_actor(this.actor);
    //dummyBox.destroy();
    let children = null,
    childrenL = 0;
    switch (this._position_in_panel) {
    case MycroftPosition.LEFT:
      children = Main.panel._leftBox.get_children();
      childrenL = children.length > 0 ? children.length : 0;
      Main.panel._leftBox.insert_child_at_index(this.container, childrenL);
      break;
    case MycroftPosition.CENTER:
      children = Main.panel._centerBox.get_children();
      childrenL = children.length > 0 ? children.length : 0;
      Main.panel._centerBox.insert_child_at_index(this.container, childrenL);
      break;
    case MycroftPosition.RIGHT:
      children = Main.panel._rightBox.get_children();
      Main.panel._rightBox.insert_child_at_index(this.container, 0);
      break;
    default:
      // do nothing
    }
    // Add Menu to panel
    if (Main.panel._menus === undefined) {
      Main.panel.menuManager.addMenu(this.menu);
    } else {
      Main.panel._menu.addMenu(this.menu);
    }
    this.a = 10;
  }
  checkPositionInPanel() {
    if (this._old_position_in_panel !== position_in_panel) {
      switch (this._old_position_in_panel) {
      case MycroftPosition.LEFT:
        Main.panel._leftBox.remove_actor(this.actor);
        break;
      case MycroftPosition.CENTER:
        Main.panel._centerBox.remove_actor(this.actor);
        break;
      case MycroftPosition.RIGHT:
        Main.panel._rightBox.remove_actor(this.actor);
        break;
      default:
        // do nothing
      }
      let children = null,
        childrenL = 0;
      switch (position_in_panel) {
      case MycroftPosition.LEFT:
        children = Main.panel._leftBox.get_children();
        childrenL = children.length > 0 ? children.length : 0;
        Main.panel._leftBox.insert_child_at_index(this.actor, childrenL);
        break;
      case MycroftPosition.CENTER:
        children = Main.panel._centerBox.get_children();
        childrenL = children.length > 0 ? children.length : 0;
        Main.panel._centerBox.insert_child_at_index(this.actor, childrenL);
        break;
      case MycroftPosition.RIGHT:
        children = Main.panel._rightBox.get_children();
        Main.panel._rightBox.insert_child_at_index(this.actor, 0);
        break;
      default:
        // do nothing
      }
      this._old_position_in_panel = position_in_panel;
    }
  }
  updatePanelIcon(){
    this.colorizeEffect = new Clutter.ColorizeEffect({
      enabled: true,
    });
    //TODO removed for compiatbility
    //this.colorizeEffect.set_tint(getColor(status));
    this._mycroftIcon.clear_effects();
    this._mycroftIcon.add_effect(this.colorizeEffect);
  }
  removePanelIcon(){
    switch (this._position_in_panel) {
    case MycroftPosition.LEFT:
      Main.panel._leftBox.remove_actor(this.actor);
      break;
    case MycroftPosition.CENTER:
      Main.panel._centerBox.remove_actor(this.actor);
      break;
    case MycroftPosition.RIGHT:
      Main.panel._rightBox.remove_actor(this.actor);
      break;
    default:
      // do nothing
    }
  }
});

const MycroftPopup = GObject.registerClass({
  GTypeName: 'MycroftPopup'
}, class MycroftPopup extends GObject.Object{
  constructor() {
    super();
    this.topMenuBar = new TopMenuBar();

    this.popupMenuMain = new PopupMenu.PopupBaseMenuItem({
      reactive: false,
      style_class: 'main-window',
      can_focus: false,
    });
    this.mainBox = new St.BoxLayout({
      name: 'main-box',
      vertical: true,
    });
    //Changed for compitability
    /*
    this.mainBox.add_actor(this.topMenuBar.menuBar, {
      x_fill: true,
      x_align: St.Align.MIDDLE,
    });
    */
    this.mainBox.add_child(this.topMenuBar.menuBar)

    /*
    this.popupMenuMain.actor.add_actor(this.mainBox, {
      x_fill: true,
      x_align: St.Align.MIDDLE,
      y_fill: true,
    });
    */
    this.popupMenuMain.actor.add_child(this.mainBox)


    this.displayBox = new DisplayBox();
    this.mainBox.add_actor(this.displayBox.actor);
  }
  addItem(gObj) {
    this.poupMenu.Main.actor.add_actor(gObj);
  }
  removeItem(gObj) {
    this.popupMenu.Main.actor.remove_actor(gObj);
  }
  destroy() {
    this.popupMenuMain.destroy();
    this.topMenuBar.destroy();
    this.displayBox.destroy();
  }
});

const DisplayBox = GObject.registerClass({
  GTypeName: 'DisplayBox'},
  class DisplayBox extends GObject.Object{
  constructor() {
    super();
    this.actor = new St.BoxLayout({
      style_class: 'display-box',
      name: 'displayBox',
      x_expand: true,
      y_expand: true,
    });
    this.searchBox = new SearchBox();
    this.hintBox = new HintBox();
    this.actor.add_actor(this.searchBox.actor);
  }
  destroy() {
    if (this.searchBox) {
      this.searchBox.destroy();
      this.searchBox = undefined;
    }
    if (this.hintBox) {
      this.hintBox.destroy();
      this.hintBox = undefined;
    }
    if (this.actor) {
      this.actor.destroy();
      this.actor = undefined;
    }
  }
  showPage(uploader, event) {
    if (uploader.get_name() === 'hintActor') {
      this.actor.remove_actor(this.searchBox.actor);
      this.actor.add_actor(this.hintBox.actor);
    } else if (uploader.get_name() === 'searchActor') {
      this.searchBox.conversationBox.clearConversation();
      this.actor.remove_actor(this.hintBox.actor);
      this.actor.add_actor(this.searchBox.actor);
    }
  }
});
const SearchBox = GObject.registerClass({
  GTypeName: 'SearchBox'},
  class SearchBox extends GObject.Object {
    constructor() {
      super();
      this.actor = new St.BoxLayout({
        name: 'searchBox',
        x_expand: true,
        y_expand: true,
        vertical: true,
      });
      this.barAnimation = new MycroftBarAnimation();
      this.actor.add_actor(this.barAnimation.animationBox);
      this.sBox = new St.BoxLayout({
        x_expand: true,
        y_expand: true,
        y_align: Clutter.ActorAlign.END,
        vertical: true,
      });
      this.actor.add_actor(this.sBox);
      this.chatBox = new ChatBox();
      this.conversationBox = new ConversationBox();

      this.label = new St.Label({
        name: 'basic-text',
        text: 'Mycroft is disabled',
        style_class: 'search-box-label disabled',
        y_align: Clutter.ActorAlign.END,
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      this.label.clutter_text.line_wrap = true;
      this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
      this.label.clutter_text.x_align = Clutter.ActorAlign.CENTER;
      this.sBox.add_actor(this.label);
  }
  destroy() {
    if (this.barAnimation) {
      this.barAnimation.destroy();
      this.barAnimation = undefined;
    }
    if (this.chatBox) {
      this.chatBox.destroy();
      this.chatBox = undefined;
    }
    if (this.conversationBox) {
      this.conversationBox.destroy();
      this.conversationBox = 0;
    }
    if (this.sBox) {
      this.sBox.destroy();
      this.sBox = undefined;
    }
    if (this.actor) {
      this.actor.destroy();
      this.actor = undefined;
    }
  }
  updateStatus(status) {
    switch (status) {
    case 'active':
    case 'listening':
      this.sBox.remove_all_children();
      this.sBox.add_actor(this.conversationBox.actor);
      this.sBox.add_actor(this.chatBox.messageBox);
      break;
    case 'starting':
      this.sBox.remove_all_children();
      this.label.set_text(
          'Your Mycroft Assistant is just starting up. Please wait'
        );
      this.sBox.add_actor(this.label);
      break;
    case 'disabled':
      this.sBox.remove_all_children();
      this.label.set_text('Your Mycroft Assistant is currently disabled');
      this.sBox.add_actor(this.label);
      break;
    case 'failed':
      this.sBox.remove_all_children();
      this.label.set_text(
          'There was an error reaching your Mycroft Assistant. Click the reload button to try again'
        );
      this.sBox.add_actor(this.label);
      break;
    case 'remote-error':
      this.sBox.remove_all_children();
      this.label.set_text(
          'Can\'t connect to remote Mycroft Assistant. Please check the ip address and port number'
        );
      this.sBox.add_actor(this.label);
      status = 'failed';
      break;
    case 'install':
      this.sBox.remove_all_children();
      this.label.set_text(
          'Please setup up this extension from the settings of the extension'
        );
      this.sBox.add_actor(this.label);
      break;
    default:
      // do nothing
    }
    this.updateStatusLabelStyle(status);
  }
  updateStatusLabelStyle(status) {
    let style = this.label.get_style_class_name();
    let abc = style.split(' ');
    this.label.remove_style_class_name(abc[1]);
    this.label.add_style_class_name(status);
  }
});

const HintBox = GObject.registerClass({
  GTypeName: 'HintBox'},
  class HintBox extends GObject.Object {
  constructor() {
    super();
    this.actor = new St.BoxLayout({
      name: 'hintBox',
      style_class: 'hint-box',
      x_expand: true,
      y_expand: true,
    });

    this._scrollView = new St.ScrollView({
      style_class: 'scroll-view verticalfade',
      x_expand: true,
      y_expand: true,
      //x_fill: true,
      //y_fill: true,
    });
    this._scrollView.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
    this.actor.add_actor(this._scrollView);

    this.hintView = new St.BoxLayout({
      name: 'hintView',
      vertical: true,
    });
    this._scrollView.add_actor(this.hintView);
    this.hintText();
  }
  addHeader(text) {
    let label = new St.Label({
      text: text,
      style_class: 'hint-header',
    });
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    this.hintView.add_actor(label);
  }
  addText(text) {
    let labelBin = new St.BoxLayout({
      name: 'labelBin',
    });
    let tempLabel = new St.Label({
      text: 'Hey Mycroft, ',

      style_class: 'hint-text hint-text-bold',
    });
    let label = new St.Label({
      text: text,
      style_class: 'hint-text',
    });
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    labelBin.add_actor(tempLabel);
    labelBin.add_actor(label);
    this.hintView.add_actor(labelBin);
  }
  hintText() {
    let hintInfo = [
      {
        header: 'Alarm',
        text: [ 'Set alarm for 6:00 AM', 'Set alarm for 12:00 AM on 1st January' ],
      },
      {
        header: 'Date & Time',
        text: [ 'What is the current time', 'Current date in London' ],
      },
      {
        header: 'Desktop',
        text: [ 'Open Firefox', 'Open Konsole' ],
      },
      {
        header: 'Joke',
        text: [ 'Tell me a joke', 'Meaning of life' ],
      },
      {
        header: 'WiKi',
        text: [ 'Wiki the Moon', 'Define Relativity' ],
      },
      {
        header: 'Wolfram Alpha',
        text: [ 'What is 2+2', 'Calculate the Pi' ],
      },
      {
        header: 'Weather',
        text: [ 'What is the current weather', 'Current weather in Tokyo' ],
      },
    ];
    for (let i = 0; i < hintInfo.length; i++) {
      this.addHeader(hintInfo[i].header);
      for (let j = 0; j < hintInfo[i].text.length; j++) {
        this.addText(hintInfo[i].text[j]);
      }
    }
  }
  destroy() {
    if (this.hintView) {
      this.hintView.destroy();
      this.hintView = undefined;
    }
    if (this._scrollView) {
      this._scrollView.destroy();
      this._scrollView = undefined;
    }
    if (this.actor) {
      this.actor.destroy();
      this.actor = undefined;
    }
  }
});
const ConversationBox = GObject.registerClass({
  GTypeName: 'ConversationBox'},
  class ConversationBox extends GObject.Object{ 
  constructor() {
    super();
    this.clearId = 0;
    this.actor = new St.BoxLayout({
      style_class: 'conversation-box',
      x_expand: true,
      y_expand: true,
    });

    this._scrollView = new St.ScrollView({
      style_class: 'scroll-view verticalfade',
      x_expand: true,
      y_expand: true,
    });
    this._scrollView.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
    this.actor.add_actor(this._scrollView);

    this.conversationView = new St.BoxLayout({
      name: 'conversationBox',
      vertical: true,
    });
    this._scrollView.add_actor(this.conversationView);
    (this._initMessage = new St.Label({
      name: 'initMessage',
      x_align: Clutter.ActorAlign.START,
      text: 'Ask from one of the suggestions',
    })),
      (this._initButton = new St.Button({
        name: 'initButton',
        x_align: Clutter.ActorAlign.START,
        child: this._initMessage,
      }));

    this.conversationView.add_actor(this._initButton);
    this._initButton.set_x_align(Clutter.ActorAlign.CENTER);
  }
  destroy() {
    if (this.clearId) {
      this._initButton.disconnect(this.clearId);
      this.clearId = 0;
    }
    if (this._scrollView) {
      this._scrollView.destroy();
      this._scrollView = undefined;
    }
    if (this._conversationView) {
      this._conversationView.destroy();
      this._conversationView = undefined;
    }
    if (this._initButton) {
      this._initButton.destroy();
      this._initButton = undefined;
    }
    if (this.actor) {
      this.actor.destroy();
      this.actor = undefined;
    }
  }
  addMessage(uploader, message, reciever) {
    let labelCss = reciever === 'me' ? 'sent-label' : 'reciever-label';
    let align =
      reciever === 'me' ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
    let label = new St.Label({
      style_class: 'conversation-label ' + labelCss,
      x_align: align,
      text: message,
    });
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    this.conversationView.add_actor(label);
    if (this.conversationView.get_n_children() > 1) {
      if (this.clearId === 0) {
        this.clearId = this._initButton.connect(
          'button-press-event',
          Lang.bind(this, this.clearConversation)
        );
        this._initMessage.set_text('Clear this conversation');
        this._initButton.add_style_class_name('clear-button');
        this._initButton.set_x_align(Clutter.ActorAlign.START);
      }
    }
    Util.ensureActorVisibleInScrollView(this._scrollView, label);
  }
  clearConversation() {
    if (this.clearId !== 0) {
      this._initButton.disconnect(this.clearId);
      this.clearId = 0;
    }
    this.conversationView.remove_all_children();
    this._initMessage.set_text('Ask from one of the suggestions');
    this._initButton.set_x_align(Clutter.ActorAlign.CENTER);
    this._initButton.remove_style_class_name('clear-button');
    this.conversationView.add_actor(this._initButton);
  }
});

const ChatBox = GObject.registerClass({
  GTypeName: 'ChatBox',
  Signals: {
      'send-message': {
        param_types: [GObject.TYPE_STRING],
      },
    },
  },
  class ChatBox extends PopupMenu.PopupBaseMenuItem {
  constructor() {
    super();
    this.inputStream = new InputStream();
    this.messageBox = new St.BoxLayout({
      name: 'messageBox',
      style_class: 'message-box',
      x_align: Clutter.ActorAlign.CENTER,
      vertical: true,
    });
    this._suggestionsResults = new SuggestionsBox();
    this._suggestionsBin = new St.Bin({
      child: this._suggestionsResults.actor,
      x_align: St.Align.START,
    });
    this.messageBox.add_actor(this._suggestionsResults.suggestFocus);
    this.messageBox.add_actor(this._suggestionsBin);

    this._entry = new St.Entry({
      style_class: 'utterance-entry',
      hint_text: 'Type to search...',
      track_hover: true,
      can_focus: true,
    });

    this._entryBin = new St.Bin({
      child: this._entry,
      x_align: St.Align.MIDDLE,
    });
    this._text = this._entry.clutter_text;
    this._suggestionsActive = false;
    this._textChangedId = this._text.connect(
      'text-changed',
      Lang.bind(this, this._onTextChanged)
    );
    this._textKeyPressedId = this._text.connect(
      'key-press-event',
      Lang.bind(this, this._onKeyPress)
    );
    this._primaryIcon = new St.Icon({
      style_class: 'utterance-mic-icon',
      icon_name: 'audio-input-microphone-muted-symbolic',
    });
    this._clearIcon = new St.Icon({
      style_class: 'utterance-entry-icon',
      icon_name: 'edit-clear-symbolic',
    });

    // primary-icon-clicked does not throw event. Throws secondary-icon-clicked instead. Maybe report this to GNOME.
    this._entry.set_primary_icon(this._primaryIcon);

    this._primaryIconClickedId = this._primaryIcon.connect(
      'button-release-event',
      Lang.bind(this, this._onPrimaryIconClick)
    );

    this._secondaryIconClickedId = 0;

    this.messageBox.add_actor(this._entryBin);

    this.setEventListeners();
  }
  setEventListeners() {
    this.suggestionsClickedId = this._suggestionsResults.connect(
      'suggestions-clicked',
      Lang.bind(this, this.suggestionsClick)
    );
    this.suggestionsEntryFocusId = this._suggestionsResults.connect(
     'enter-event',
      Lang.bind(this, this._entryFocus)
    );
    this.inputStreamId = this.inputStream.connect(
     'stream-status',
    Lang.bind(this, this._isMuted)
    );
  }
  destroy() {
    if (this._textChangedId) {
      this._text.disconnect(this._textChangedId);
      this._textChangedId = 0;
    }
    if (this._textKeyPressedId) {
      this._text.disconnect(this._textKeyPressedId);
      this._textKeyPressedId = 0;
    }
    if (this._primaryIconClickedId) {
      this._primaryIcon.disconnect(this._primaryIconClickedId);
      this._primaryIcon = 0;
    }
    if (this._secondaryIconClickedId) {
      this._entry.disconnect(this._secondaryIconClickedId);
      this._secondaryIconClicked = 0;
    }
    if (this.suggestionsClickedId) {
      this._suggestionsResults.disconnect(this.suggestionsClickedId);
      this._suggestionsClickedId = 0;
    }
    if (this.suggestionsEntryFocusId) {
      this._suggestionsResults.disconnect(this.suggestionsEntryFocusId);
      this.suggestionsEntryFocusId = 0;
    }
    if (this.inputStreamId) {
      this.inputStream.disconnect(this.inputStreamId);
      this.inputStreamId = 0;
    }
    if (this._suggestionsResults) {
      this._suggestionsResults.destroy();
      this._suggestionsResults = undefined;
    }
    if (this.inputStream) {
      this.inputStream.destroy();
      this.inputStream = undefined;
    }
    if (this.messageBox) {
      this.messageBox.destroy();
      this.messageBox = undefined;
    }
    if (this._suggestionsBin) {
      this._suggestionsBin.destroy();
      this._suuggestionsBin = undefined;
    }
    if (this._entryBin) {
      this._entry.destroy();
      this._entryBin.destroy();
      this._entry = undefined;
      this._entryBin = undefined;
    }
  }
  _entryFocus() {
    this._entry.grab_key_focus();
  }
  suggestionsClick(uploader, suggestString) {
    if (this._suggestionsResults.suggestionFound) {
      this.reset();
    }
    let tempText = this._entry.get_text();
    let sameText = tempText.lastIndexOf(' ');
    if (sameText !== -1) {
      tempText = tempText.slice(0, sameText);
      this._entry.set_text(tempText + ' ' + suggestString + ' ');
    } else {
      this._entry.set_text(suggestString + ' ');
    }
  }
  reset() {
    this._entry.text = '';

    this._text.set_cursor_visible(true);
    this._text.set_selection(0, 0);
  }
  getTermsForSearchString(searchString) {
    searchString = searchString.replace(/^\s+/g, '').replace(/\s+$/g, '');
    if (searchString === '') {
      return [];
    }

    let terms = searchString.split(/\s+/);
    return terms;
  }
  _onTextChanged(se, prop) {
    let terms = this.getTermsForSearchString(this._entry.get_text());
    this._suggestionsActive = terms.length > 0;

    if (this._suggestionsActive) {
      this._suggestionsResults.setTerms(terms);
      this._entry.set_secondary_icon(this._clearIcon);
      if (this._secondaryIconClickedId === 0) {
        this._secondaryIconClickedId = this._entry.connect(
          'secondary-icon-clicked',
          Lang.bind(this, this.reset)
        );
      }
    } else {
      if (this._secondaryIconClickedId > 0) {
        this._entry.disconnect(this._secondaryIconClickedId);
        this._secondaryIconClickedId = 0;
      }

      this._entry.set_secondary_icon(null);
      this._suggestionsResults.setSuggestionsRandom();
      if (this._text.text !== '') {
        this.reset();
      }
    }
  }
  _onPrimaryIconClick() {
    this.inputStream.emit('mute');
  }
  _isMuted(uploader, volume) {
    if (!this.inputStream._stream.is_muted) {
      if (volume === 0) {
        this._primaryIcon.set_icon_name(
          'microphone-sensitivity-muted-symbolic'
        );
      } else if (volume > 0 && volume < 0.33) {
        this._primaryIcon.set_icon_name('microphone-sensitivity-low-symbolic');
      } else if (volume >= 0.33 && volume <= 0.66) {
        this._primaryIcon.set_icon_name(
          'microphone-sensitivity-medium-symbolic'
        );
      } else if (volume >= 0.66) {
        this._primaryIcon.set_icon_name('microphone-sensitivity-high-symbolic');
      }
    } else {
      this._primaryIcon.set_icon_name('microphone-sensitivity-muted-symbolic');
    }
  }
  _isActivated() {
    return this._text.text === this._entry.get_text();
  }
  _suggestionsCancelled() {
    this._suggestionsResults._hide();

    // Leave the entry focused when it doesn't have any text;
    // when replacing a selected search term, Clutter emits
    // two 'text-changed' signals, one for deleting the previous
    // text and one for the new one - the second one is handled
    // incorrectly when we remove focus
    // (https://bugzilla.gnome.org/show_bug.cgi?id=636341) */
    if (this._text.text !== '') {
      this.reset();
    }
  }
  _onKeyPress(entry, event) {
  
    let symbol = event.get_key_symbol();
    if (symbol === Clutter.Escape) {
      if (this._isActivated()) {
        this.reset();
        return Clutter.EVENT_STOP;
      }
    } else if (symbol === Clutter.Up || symbol === Clutter.KEY_Up) {
      this._suggestionsResults.suggestFirstButton.grab_key_focus();
      return Clutter.EVENT_STOP;
    } else if (symbol === Clutter.Return || symbol === Clutter.KP_Enter || symbol === Clutter.KEY_Return) {
      this.sendMessage(this._entry.get_text());
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }
  sendMessage(utteranceString) {
    if (utteranceString.trim() !== '') {
      this.emit('send-message', utteranceString.trim());
    }
  }
});
const InputStream = GObject.registerClass({
  GTypeName: 'InputStream',
  Signals: {
    'stream-status' : {
      param_types: [GObject.TYPE_FLOAT],
    }
  }},
  class InputStream extends PopupMenu.PopupBaseMenuItem{
  constructor() {
    super();
    this._control = getMixerControl();
    this._controtStateChangedId = this._control.connect(
      'state-changed',
      Lang.bind(this, this._onControlStateChanged)
    );
  }
  set stream(stream) {
    if (this._stream) {
      this._disconnectStream(this._stream);
    }

    this._stream = stream;

    if (this._stream) {
      this._connectStream(this._stream);
    }
  }
  destroy() {
    if (this._controtStateChangedId) {
      this._control.disconnect(this._controtStateChangedId);
      this._controtStateChangedId = 0;
    }
    if (this._muteClickedId) {
      this.disconnect(this._muteClickedId);
      this._muteClickedId = 0;
    }
    if (this._mutedChangedId) {
      this._stream.disconnect(this._mutedChangedId);
      this._mutedChangedId = 0;
    }
    if (this._volumeChangedId) {
      this._stream.disconnect(this._volumeChangedId);
      this._volumeChangedId = 0;
    }
  }
  get stream() {
    return this._stream;
  }
  _onControlStateChanged() {
    if (this._control.get_state() === Gvc.MixerControlState.READY) {
      this._readInput();
    } else {
      this.emit('stream-active');
    }
  }
  _readInput() {
    this.stream = this._control.get_default_source();
  }
  _connectStream(stream) {
    this.volume = this._stream.volume / this._control.get_vol_max_norm();
    //TODO removed for compitablity
    //this._muteClickedId = this.connect('mute', Lang.bind(this, this._mute));
    this._mutedChangedId = stream.connect(
      'notify::is-muted',


      
      Lang.bind(this, this._updateVolume)
    );
    this._volumeChangedId = stream.connect(
      'notify::volume',
      Lang.bind(this, this._updateVolume)
    );
    //TODO removed for compitability
    //this.emit('stream-status', this.volume);
  }
  _disconnectStream(stream) {
    //this.disconnect(this._muteClickedId);
    this._muteClickedId = 0;
    if (stream) {
      stream.disconnect(this._mutedChangedId);
      this._mutedChangedId = 0;
      stream.disconnect(this._volumeChangedId);
      this._volumeChangedId = 0;
    }
  }
  _mute() {
    let isMuted;
    if (!this._stream) {
      return;
    }
    let prevMuted = this._stream.is_muted;
    if (!prevMuted) {
      this._stream.change_is_muted(true);
    } else if (prevMuted) {
      this.volume = this.volume === 0 ? 0.5 : this.volume;
      this._stream.volume = this.volume * this._control.get_vol_max_norm();
      this._stream.change_is_muted(false);
    }
    this._stream.push_volume();
    this.emit('stream-status', this.volume);
  }
  _unmute() {
    this._stream.volume = volume;
    if (prevMuted) {
      this._stream.change_is_muted(false);
    }
    this.emit('unmute_stream');
    this._stream.push_volume();
  }
  _updateVolume() {
    let muted = this._stream.is_muted;
    if (!muted) {
      this.volume = this._stream.volume / this._control.get_vol_max_norm();
    }
    this.emit('stream-status', this.volume);
  }
});
const SuggestionsBox = GObject.registerClass({
  GTypeName: 'SuggestionsBox',
  Signals: {
    'suggestions-clicked': {
      param_types: [GObject.TYPE_STRING],
    },
    'entry-focus': {},
  }},
  class SuggestionsBox extends PopupMenu.PopupBaseMenuItem {
  constructor() {
    super();
    this._suggestionBox = new St.BoxLayout({
      name: 'suggestionsBox',
      style_class: 'suggestions-box',
    });
    this.suggestFirstLabel = new St.Label({
      name: 'suggestionFirst',
      text: 'first',
    });
    this.suggestFirstButton = new St.Button({
      name: 'suggestFirstButton',
      child: this.suggestFirstLabel,
      can_focus: true,
      style_class: 'suggestions-label',
    });
    this.suggestSecondLabel = new St.Label({
      name: 'suggestionSecond',
      text: 'second',
    });
    this.suggestSecondButton = new St.Button({
      name: 'suggestSecondButton',
      child: this.suggestSecondLabel,
      can_focus: true,
      z_position: 1,
      style_class: 'suggestions-label',
    });
    this.suggestThirdLabel = new St.Label({
      name: 'suggestionThird',
      z_position: 1,
      text: 'third',
    });
    this.suggestThirdButton = new St.Button({
      name: 'suggestThirdButton',
      child: this.suggestThirdLabel,
      can_focus: true,
      z_position: 1,
      style_class: 'suggestions-label',
    });
    this.suggestFocus = new St.Label({
      name: 'suggestFocusLabel',
      text: ' ',
      style_class: 'suggestions-focus-label',
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.START,
    });
    this.clearText = new St.Label({
      name: 'clearConversation_',
      text: 'Clear',
    });

    this.add_child(this._suggestionBox);
    this._suggestionBox.add_actor(this.suggestFirstButton);
    this._suggestionBox.add_actor(this.suggestSecondButton);
    this._suggestionBox.add_actor(this.suggestThirdButton);
    this.setEventListeners();
    this.initSuggestionFiles();
  }
  setEventListeners() {
    this.suggestFirstButtonButtonId = this.suggestFirstButton.connect(
      'button-press-event',
      Lang.bind(this, this.sendSuggestion)
    );
    this.suggestSecondButtonButtonId = this.suggestSecondButton.connect(
      'button-press-event',
      Lang.bind(this, this.sendSuggestion)
    );
    this.suggestThirdButtonButtonId = this.suggestThirdButton.connect(
      'button-press-event',
      Lang.bind(this, this.sendSuggestion)
    );
    this.suggestFirstButtonKeypressId = this.suggestFirstButton.connect(
      'key-press-event',
      Lang.bind(this, this.sendSuggestion)
    );
    this.suggestSecondButtonKeypressId = this.suggestSecondButton.connect(
      'key-press-event',
      Lang.bind(this, this.sendSuggestion)
    );
    this.suggestThirdButtonKeypressId = this.suggestThirdButton.connect(
      'key-press-event',
      Lang.bind(this, this.sendSuggestion)
    );
    this.suggestFirstButtonStyleId = this.suggestFirstButton.connect(
      'style-changed',
      Lang.bind(this, this.showSuggestFocus)
    );
    this.suggestSecondButtonStyleId = this.suggestSecondButton.connect(
      'style-changed',
      Lang.bind(this, this.showSuggestFocus)
    );
    this.suggestThirdButtonStyleId = this.suggestThirdButton.connect(
      'style-changed',
      Lang.bind(this, this.showSuggestFocus)
    );
  }
  destroy() {
    if (this.suggestFirstButtonButtonId) {
      this.suggestFirstButton.disconnect(this.suggestFirstButtonButtonId);
      this.suggestFirstButtonButtonId = 0;
    }
    if (this.suggestSecondButtonButtonId) {
      this.suggestSecondButton.disconnect(this.suggestSecondButtonButtonId);
      this.suggestSecondButtonButtonId = 0;
    }
    if (this.suggestThirdButtonButtonId) {
      this.suggestThirdButton.disconnect(this.suggestThirdButtonButtonId);
      this.suggestThirdButtonButtonId = 0;
    }
    if (this.suggestFirstButtonKeypressId) {
      this.suggestFirstButton.disconnect(this.suggestFirstButtonKeypressId);
      this.suggestFirstButtonKeypressId = 0;
    }
    if (this.suggestSecondButtonKeypressId) {
      this.suggestSecondButton.disconnect(this.suggestSecondButtonKeypressId);
      this.suggestSecondButtonKeypressId = 0;
    }
    if (this.suggestThirdButtonKeypressId) {
      this.suggestThirdButton.disconnect(this.suggestThirdButtonKeypressId);
      this.suggestThirdButtonKeypressId = 0;
    }
    if (this.suggestFirstButtonStyleId) {
      this.suggestFirstButton.disconnect(this.suggestFirstButtonStyleId);
      this.suggestFirstButtonStyleId = 0;
    }
    if (this.suggestSecondButtonStyleId) {
      this.suggestSecondButton.disconnect(this.suggestSecondButtonStyleId);
      this.suggestSecondButtonStyleId = 0;
    }
    if (this.suggestThirdButtonStyleId) {
      this.suggestThirdButton.disconnect(this.suggestThirdButtonStyleId);
      this.suggestThirdButtonStyleId = 0;
    }
    if (this.actor) {
      this.actor.destroy();
      this.actor = undefined;
    }
    if (this.suggestFirstButton) {
      this.suggestFirstButton.destroy();
      this.suggestFirstButton = undefined;
    }
    if (this.suggestSecondButton) {
      this.suggestSecondButton.destroy();
      this.suggestSecondButton = undefined;
    }
    if (this.suggestThirdButton) {
      this.suggestThirdButton.destroy();
      this.suggestThirdButton = undefined;
    }
    if (this.suggestFocus) {
      this.suggestFocus.destroy();
      this.suggestFocus = undefined;
    }
    if (this.clearText) {
      this.clearText.destroy();
      this.clearText = undefined;
    }
  }
  initSuggestionFiles() {
    let keywordFileTemp, listFileTemp;
    let path = EXTENSIONDIR + '/suggestions/words1.txt';
    let wordlist = this.readFile(path);
    this.wordListArray = ByteArray.toString(wordlist).split('\n');
    this.wordListArray = this.wordListArray.filter(Boolean);
    let baseLocation = EXTENSIONDIR + '/suggestions/';
    let files = [
      {
        id: '1',
        category: 'math',
        keywordFile: baseLocation + 'MathKeywords.txt',
        listFile: baseLocation + 'MathList.txt',
      },
      {
        id: '2',
        category: 'general',
        keywordFile: baseLocation + 'GeneralKeywords.txt',
        listFile: baseLocation + 'GeneralList.txt',
      },
      {
        id: '3',
        category: 'desktop',
        keywordFile: baseLocation + 'DesktopKeywords.txt',
        listFile: baseLocation + 'DesktopList.txt',
      },
      {
        id: '4',
        category: 'weather',
        keywordFile: baseLocation + 'WeatherKeywords.txt',
        listFile: baseLocation + 'WeatherList.txt',
      },
      {
        id: '5',
        category: 'wiki',
        keywordFile: baseLocation + 'WikiKeywords.txt',
        listFile: baseLocation + 'WikiList.txt',
      },
    ];
    for (let i = 0; i < files.length; i++) {
      keywordFileTemp = this.readFile(files[i].keywordFile);
      keywordFileTemp = ByteArray.toString(keywordFileTemp).toString().split('\n');
      keywordFileTemp = keywordFileTemp.filter(Boolean);
      files[i].keywordFile = keywordFileTemp;
      listFileTemp = this.readFile(files[i].listFile);
      listFileTemp = ByteArray.toString(listFileTemp).split('\n');
      listFileTemp = listFileTemp.filter(Boolean);
      files[i].listFile = listFileTemp;
    }
    this.files = files;
    this.setSuggestionsRandom();
  }
  showSuggestFocus(uploader, event) {
    if (
      uploader.has_style_pseudo_class('focus') ||
      uploader.has_style_pseudo_class('hover')
    ) {
      this.suggestFocus.set_text(uploader.get_child().text);
      this.suggestFocus.remove_style_class_name('suggestions-focus-label');
      this.suggestFocus.add_style_class_name('suggestions-focus-label-active');
    } else {
      this.suggestFocus.remove_style_class_name(
        'suggestions-focus-label-active'
      );
      this.suggestFocus.add_style_class_name('suggestions-focus-label');
      this.suggestFocus.set_text(' ');
    }
  }
  sendSuggestion(uploader, event) {
    let suggestString;
    if (event.type() === 1) {
      let symbol = event.get_key_symbol();
      if (symbol === Clutter.Return || symbol === Clutter.KP_Enter) {
        suggestString = uploader.get_child().text;
        this.emit('suggestions-clicked', suggestString);
        return Clutter.EVENT_STOP;
      } else if (symbol === Clutter.Right) {
        this.suggestFirstButton.has_key_focus() ?
          this.suggestSecondButton.grab_key_focus() :
          this.suggestSecondButton.has_key_focus() ?
          this.suggestThirdButton.grab_key_focus() :
          this.suggestFirstButton.grab_key_focus();
        return Clutter.EVENT_STOP;
      } else if (symbol === Clutter.Left) {
        this.suggestThirdButton.has_key_focus() ?
          this.suggestSecondButton.grab_key_focus() :
          this.suggestSecondButton.has_key_focus() ?
          this.suggestFirstButton.grab_key_focus() :
          this.suggestThirdButton.grab_key_focus();
        return Clutter.EVENT_STOP;
      } else if (symbol === Clutter.Down) {
        this.emit('entry-focus');
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    } else if (event.type() === 6) {
      suggestString = uploader.get_child().text;
      this.emit('suggestions-clicked', suggestString);
      return Clutter.EVENT_PROPAGATE;
    }
    return 0;
  }
  setTerms(suggestTerm) {
    if (suggestTerm.length > 0) {
      let keywordToSearch = suggestTerm[suggestTerm.length - 1];
      let result = this.wordSuggest(keywordToSearch);
      if (result) {
        this.suggestFirstLabel.set_text(result[0]);
        this.suggestSecondLabel.set_text(result[1]);
        this.suggestThirdLabel.set_text(result[2]);
      } else {
        this.suggestFirstLabel.set_text('first');
        this.suggestSecondLabel.set_text('second');
        this.suggestThirdLabel.set_text('third');
      }
    }
  }
  wordSuggest(keywordToSearch) {
    keywordToSearch = keywordToSearch.toString().toLowerCase();
    let len = 0,
      files = this.files,
      a,
      i,
      j,
      l,
      k,
      baseSearch,
      keywords,
      keywordsFile,
      list,
      listFile,
      suggestion = [];
    for (i = 0; i < files.length; i++) {
      baseSearch = files[i];
      keywords = baseSearch.keywordFile;
      // keywords = keywords.filter(Boolean);
      for (j = 0; j < keywords.length; j++) {
        if (keywordToSearch.indexOf(keywords[j]) !== -1) {
          list = baseSearch.listFile;
          len = 0;
          for (l = 0; l < list.length; l++) {
            if (list[l].indexOf(keywordToSearch) !== -1) {
              this.suggestionFound = true;
              if (len < 3) {
                suggestion[len] = list[l];
                len++;
              }
            }
          }
          if (suggestion.length > 0) {
            for (a = suggestion.length; a < 3; a++) {
              suggestion[a] = list[Math.floor(list.length * Math.random())];
            }
            return suggestion;
          }
          for (k = 0; k < 3; k++) {
            suggestion[k] = list[Math.floor(list.length * Math.random())];
          }
          return suggestion;
        }
      }
    }

    if (suggestion.length < 1) {
      let wordListArray = this.wordListArray;

      suggestion = wordListArray.filter(function (stackValue) {
        // get rid of all falsely objects
        if (stackValue) {
          return (
            stackValue.substring(0, keywordToSearch.length) === keywordToSearch
          );
        }
        return stackValue;
      });

      if (suggestion.length < 3) {
        for (a = suggestion.length; a < 3; a++) {
          suggestion[a] =
            wordListArray[Math.floor(wordListArray.length * Math.random())];
        }
      } else {
        for (k = 0; k < 3; k++) {
          suggestion[k] =
            suggestion[Math.floor(suggestion.length * Math.random())];
        }
      }
      this.suggestionFound = false;
      return suggestion;
    }
    return suggestion;
  }
  readFile(filename) {
    if (GLib.file_test(filename, GLib.FileTest.EXISTS)) {
      let file = Gio.file_new_for_path(filename);
      try {
        let [ ok, contents, tag ] = file.load_contents(null);
        return contents;
      } catch (e) {
        log('Mycroft UI - Read File' + e);
        return 0;
      }
    } else {
      return 0;
    }
  }
  _suggestionsRandom() {
    let randomFile,
      randomText = [];
    for (let i = 0; i < 3; i++) {
      randomFile = this.files[Math.floor(this.files.length * Math.random())]
        .listFile;
      randomText[i] = randomFile[Math.floor(randomFile.length * Math.random())];
    }
    return randomText;
  }
  setSuggestionsRandom() {
    let random = this._suggestionsRandom();
    this.suggestFirstLabel.set_text(random[0]);
    this.suggestSecondLabel.set_text(random[1]);
    this.suggestThirdLabel.set_text(random[2]);
  }
});
const MycroftBarAnimation = GObject.registerClass({
  GTypeName: 'MycroftBarAnimation'},
  class MycroftBarAnimation extends GObject.Object{
  constructor() {
    super();
    this.animationBox = new St.BoxLayout({
      name: 'animationBox',
      x_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.START,
    });

    let screen_image = Me.dir.get_child('icons').get_child('mycroftLogo60.png');
    this.colorizeEffect = new Clutter.ColorizeEffect({
      enabled: true,
    });
    //TODO removed for compitability
    //this._icon = new Clutter.Texture({
    //  filter_quality: Clutter.TextureQuality.HIGH,
    //});
    //this._icon.set_from_file(screen_image.get_path());
    this.initActor();
  }
  initActor(status) {
    if (this.actor) {
      this.actor.clear_effects();
      this.actor.remove_actor(this._icon);
      this.animationBox.remove_actor(this.actor);
      this.actor.destroy();
      this.actor = null;
    }
    this.colorizeEffect.set_tint(getColor(status));
    //TODO removed for compitability
    //this.actor = new St.Bin({
    //  child: this._icon,
    //  y_align: St.Align.MIDDLE,
    //  x_align: Clutter.ActorAlign.START,
    //  x_expand: true,
    //  y_expand: true,
    //  effect: this.colorizeEffect,
    //});
    //this.actor.set_pivot_point(0.5, 0.5);
    //this.actor.set_scale(0.8, 0.8);
    //this.animationBox.add_actor(this.actor);
  }
  startAnimation(uploader, status) {
    this.initActor(status);
    if (animation_status) {
      Tweener.addTween(this.actor, {
        opacity: 255,
        time: 0.5,
        scale_x: 1.0,
        scale_y: 1.0,
        transition: 'easeOutQuad',
        onComplete: Lang.bind(this, function () {
          this.loopTween2();
        }),
      });
    }
  }
  loopTween() {
    Tweener.addTween(this.actor, {
      opacity: 255,
      time: 0.5,
      scale_x: 1.0,
      scale_y: 1.0,
      transition: 'easeOutQuad',
      onComplete: Lang.bind(this, function () {
        // this.actor.set_scale(0.7, 0.7);
        this.loopTween2();
      }),
    });
  }
  loopTween2() {
    Tweener.addTween(this.actor, {
      opacity: 127,
      time: 0.75,
      scale_x: 0.8,
      scale_y: 0.8,
      transition: 'easeInQuad',
      onComplete: Lang.bind(this, function () {
        this.loopTween();
      }),
    });
  }
  stopAnimation(uploader, status) {
    if (animation_status) {
      Tweener.removeTweens(this.actor);
      Tweener.addTween(this.actor, {
        opacity: 255,
        time: 2,
        scale_x: 0.8,
        scale_y: 0.8,
        transition: 'easeInQuad',
      });
    }
    this.initActor(status);
  }
  destroy() {
    if (this.actor) {
      this.actor.destroy();
      this.actor = undefined;
    }
    if (this.animationBox) {
      this.animationBox.destroy();
      this.animationBox = undefined;
    }
  }
});

const TopMenuBar = GObject.registerClass({
  GTypeName: 'TopMenuBar',
  Signals: {
    'mycroft-status' : {
      param_types: [GObject.TYPE_STRING],
    },
    'mycroft-service-clicked': {}, 
  }},
  class TopMenuBar extends PopupMenu.PopupBaseMenuItem{
  constructor() {
    // this.parent();
    super();
    this.menuBar = new St.BoxLayout({
      name: 'xyz',
      style_class: 'menuBar',
    });
    this._menuBarLEFT = new St.BoxLayout({
      name: 'menuBarLeft',
      style_class: 'menuBarLeft',
    });
    this._menuBarCENTER = new St.BoxLayout({
      name: 'menuBarCenter',
    });

    this._menuBarRIGHT = new St.BoxLayout({
      name: 'menuBarRight',
    });

    this.settingsIcon = new St.Icon({
      name: 'mycroftSettingsIcon',
      icon_name: 'applications-system-symbolic',
    });
    this.settingsActor = new St.Button({
      name: 'mycroftSettingsButton',
      style_class: 'menu-button',
      child: this.settingsIcon,
    });
    this._menuBarLEFT.add_actor(this.settingsActor);

    this.serviceIcon = new St.Icon({
      name: 'mycroftServiceStartIcon',
      icon_name: 'media-playback-start-symbolic',
      style_class: 'serviceIcon',
    });
    this.serviceActor = new St.Button({
      name: 'mycroftServiceStartButton',
      style_class: 'menu-button',
      child: this.serviceIcon,
    });
    this.serviceActor.connect(
      'clicked',
      Lang.bind(this, function () {
        this.emit('mycroft-service-clicked');
      })
    );
    this._menuBarLEFT.add_actor(this.serviceActor);

    this.statusLabel = new St.Label({
      y_align: St.Align.END,
      text: 'Mycroft is disabled',
      style_class: 'mycroft-status-text disabled',
      x_align: St.Align.MIDDLE,
      x_expand: true,
      y_expand: true,
    });
    //changed for compitability
    /*
    this._menuBarCENTER.add_actor(this.statusLabel, {
      x_expand: true,
      x_align: St.Align.MIDDLE,
      y_expand: true,
      y_align: St.Align.MIDDLE,
    });
    */
    this._menuBarCENTER.add_child(this.statusLabel)

    this.searchIcon = new St.Icon({
      icon_name: 'system-search-symbolic',
    });
    this.searchActor = new St.Button({
      name: 'searchActor',
      style_class: 'menu-button',
      child: this.searchIcon,
    });

    this._menuBarRIGHT.add_actor(this.searchActor);

    this.hintIcon = new St.Icon({
      icon_name: 'help-about-symbolic',
    });
    this.hintActor = new St.Button({
      name: 'hintActor',
      style_class: 'menu-button',
      child: this.hintIcon,
    });
    this._menuBarRIGHT.add_actor(this.hintActor);

    this.dummyIcon = new St.Icon({
      icon_name: 'help-about-symbolic',
    });
    this.dummyActor = new St.Button({
      style_class: 'menu-button',
      child: this.dummyIcon,
    });

    //changed for compitability
    /*
    this.menuBar.add_actor(this._menuBarLEFT, {
      x_align: St.Align.Start,
      min_width_set: true,
    });
    */
    this.menuBar.add_child(this._menuBarLEFT)

    /*
    //changed for compitability
    this.menuBar.add_actor(this._menuBarCENTER, {
      x_align: St.Align.CENTER,
      min_width_set: true,
    });
    */
    this.menuBar.add_child(this._menuBarCENTER)

    /*
    this.menuBar.add_actor(this._menuBarRIGHT, {
      x_align: St.Align.END,
      fixed_position_set: true,
    });
    */
    this.menuBar.add_child(this._menuBarRIGHT)

    this.setEventListeners();
  }
  setEventListeners() {
    //TODO removed for compitability
    this.updateStatusId = this.connect(
      'mycroft-status',
      Lang.bind(this, this.updateStatus)
    );
    this.hintActorId = this.hintActor.connect(
      'clicked',
      Lang.bind(this, function () {
        this.setHintActive();
      })
    );
    this.searchActorId = this.searchActor.connect(
      'clicked',
      Lang.bind(this, function () {
        this.setSearchActive();
      })
    );
  }
  updateStatus(uploader, status) {
    if (status === 'active') {
      this.setSearchActive();
    }
    status = status == 'remote-error' ? 'failed' : status;
    this.updateStatusLabelText(status);
    this.updateServiceIcon(status);
    this.updateStatusLabelStyle(status);
  }
  updateStatusLabelText(status) {
    if (status === 'failed') {
      this.statusLabel.set_text('Mycroft Service Failed');
    } else if (status === 'install') {
      this.statusLabel.set_text('Mycroft is not setup.');
    } else {
      status = status.substr(0, 1).toUpperCase() + status.substr(1);
      this.statusLabel.set_text('Mycroft is ' + status);
    }
  }
  updateStatusLabelStyle(status) {
    let style = this.statusLabel.get_style_class_name();
    let abc = style.split(' ');
    this.statusLabel.remove_style_class_name(abc[1]);
    this.statusLabel.add_style_class_name(status);
  }
  updateServiceIcon(status) {
    switch (status) {
    case 'active':
      this.serviceIcon.icon_name = 'media-playback-pause-symbolic';
      break;
    case 'disabled':
      this.serviceIcon.icon_name = 'media-playback-start-symbolic';
      break;
    case 'starting':
    case 'stopping':
      this.serviceIcon.icon_name = 'view-more-horizontal-symbolic';
      break;
    case 'install':
      this.serviceIcon.icon_name = 'media-playback-stop-symbolic';
      break;
    case 'failed':
      this.serviceIcon.icon_name = 'emblem-synchronizing-symbolic';
      break;
    default:
      // do nothing
    }
  }
  setSearchActive() {
    this.hintActor.remove_style_pseudo_class('active');
    this.searchActor.remove_style_pseudo_class('active');
    this.searchActor.add_style_pseudo_class('active');
  }
  setHintActive() {
    this.searchActor.remove_style_pseudo_class('active');
    this.hintActor.remove_style_pseudo_class('active');
    this.hintActor.add_style_pseudo_class('active');
  }
  setInactive() {
    this.hintActor.remove_style_pseudo_class('active');
    this.searchACtor.remove_style_pseudo_class('active');
  }
  destroy() {
    if (this._statusLabel) {
      this._statusLabel.destroy();
      this._statusLabel = undefined;
    }
    if (this._menuBarCENTER) {
      this._menuBarCENTER.destroy();
      this._menuBarCENTER = undefined;
    }
    if (this._menuBarLEFT) {
      this._menuBarLEFT.destroy();
      this._menuBarLEFT = undefined;
    }
    if (this._menuBarRIGHT) {
      this._menuBarRIGHT.destroy();
      this._menuBarRIGHT = undefined;
    }
    if (this.menuBar) {
      this.menuBar.destroy();
      this.menuBar = undefined;
    }
  }
});

function getColor(status) {
  let r, g, b;
  if (status === 'active') {
    (r = 10), (g = 224), (b = 10);
  } else if (status === 'starting') {
    (r = 159), (g = 73), (b = 249);
  } else if (status === 'stopping') {
    (r = 249), (g = 73), (b = 159);
  } else if (status === 'disabled') {
    (r = 255), (g = 135), (b = 0);
  } else if (status === 'install') {
    (r = 255), (g = 29), (b = 29);
  } else if (status === 'failed') {
    (r = 179), (g = 58), (b = 58);
  } else if (status === 'listening') {
    (r = 35), (g = 209), (b = 35);
  } else {
    (r = 225), (g = 225), (b = 225);
  }
  let color = new Clutter.Color({
    red: r,
    green: g,
    blue: b,
    alpha: 1,
  });
  return color;
}

function applyStyles() {
  // findPanelClass('main-window') - - - 'main-window' is the class added to PopupBaseMenuItem

  let pane = findPanelClass('main-window');
  if (!isEmpty(pane)) {
    let mycroftPopupParent = pane.popup;
    if (mycroftPopupParent._original_inline_style_ === undefined) {
      mycroftPopupParent._original_inline_style_ = mycroftPopupParent.get_style();
    }

    let popupStyle = 'padding: 0em 0em';

    mycroftPopupParent.set_style(
      popupStyle + '; ' + (mycroftPopupParent._original_inline_style_ || '')
    );
    mycroftPopupParent._popup_line_style = popupStyle;
    if (!mycroftPopupParent._popupAreaPaddingSIGNALID) {
      mycroftPopupParent._popupAreaPaddingSIGNALID = mycroftPopupParent.connect(
        'style-changed',
        function () {
          let currPopupStyle = mycroftPopupParent.get_style();
          if (
            currPopupStyle &&
            !currPopupStyle.match(mycroftPopupParent._popup_line_style)
          ) {
            mycroftPopupParent._original_inline_style_ = currPopupStyle;
            mycroftPopupParent.disconnect(
              mycroftPopupParent._popupAreaPaddingSIGNALID
            );
            delete mycroftPopupParent._popupAreaPaddingSIGNALID;
          }
        }
      );
    }
  }
}

function findPanelClass(className) {
  // Need to find a better way.
  let pane = {};
  let grandParent = Main.uiGroup.get_children();
  let parent, child, baby, seed;
  for (let i = 0; i < grandParent.length; ++i) {
    parent = grandParent[i].get_children();
    for (let j = 0; j < parent.length; ++j) {
      child = parent[j].get_children();
      for (let k = 0; k < child.length; ++k) {
        baby = child[k].get_children();
        for (let l = 0; l < baby.length; ++l) {
          seed = baby[l].get_children();
          for (let m = 0; m < seed.length; ++m) {
            if (seed[m].toString().indexOf(className) !== -1) {
              pane.popup = baby[l];
              pane.box = grandParent[i];
              return pane;
            }
          }
        }
      }
    }
  }
  return pane;
}

function isEmpty(obj) {
  for (let key in obj) {
    if (obj.hasOwnProperty(key)) {
      return false;
    }
  }
  return true;
}
// Main

function init() {
  ExtensionUtils.initTranslations('gnome-shell-extension-mycroft');
}

function enable() {
  socketClient = new Soup.Session();
  let proxy = new Soup.ProxyResolverDefault();
  Soup.Session.prototype.add_feature.call(socketClient, proxy);
  if (miPanel) {
    miPanel = null;
  }
  miPanel = new MycroftUI();
  log('enable() finsished');
  
}

function disable() {
  try {
    miPanel.destroy();
    miPanel = 0;
    Mainloop.source_remove(_timeoutId);
    if (socketClient !== undefined) {
      socketClient.abort();
      socketClient = undefined;
    }
  } catch (e) {
    log('Mycroft UI - Disable : ' + e.toString());
  }
}
