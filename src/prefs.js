const Gtk = imports.gi.Gtk;
const GObject = imports.gi.GObject;
const Gettext = imports.gettext.domain('gnome-shell-extension-mycroft');
const _ = Gettext.gettext;
const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Config = imports.misc.config;
const Convenience = Me.imports.convenience;

const EXTENSIONDIR = Me.dir.get_path();


const MYCROFT_SETTINGS_SCHEMA = 'org.gnome.shell.extensions.mycroft';
const MYCROFT_POSITION_IN_PANEL_KEY = 'position-in-panel';
const MYCROFT_ANIMATION_STATUS_KEY = 'animation-status';
const MYCROFT_CORE_LOCATION_KEY = 'mycroft-core-location';
const MYCROFT_IS_INSTALL_KEY = 'mycroft-is-install';
const MYCROFT_INSTALL_TYPE_KEY = 'mycroft-install-type';
const MYCROFT_IP_ADDRESS_KEY = 'mycroft-ip-address';
const MYCROFT_PORT_NUMBER_KEY = 'mycroft-port-number';

const MycroftInstallType = {
  GIT: 0,
  PACKAGE: 1,
  NOT_INSTALLED: 2,
  OTHER: 3,
  REMOTE: 4,
};

const MycroftPrefsWidget =  GObject.registerClass({
  Name: 'MycroftExtension.Prefs.Widget',
  GTypeName: 'MycroftExtensionPrefsWidget',
  }, class MycroftPrefsWidget extends Gtk.Window{

  constructor() {
    super();
    this._configWidgets = [];
    this.Window = new Gtk.Builder();
    this.initWindow();
    this.refreshUI();    
  }  

  initWindow() {
    this.Window.add_from_file(EXTENSIONDIR + '/mycroft-settings.ui');
    this.mainWidget = this.Window.get_object('mycroft-pref');
    this.isInstalled = this.Window.get_object('isInstalled');
    this.inputLocation = this.Window.get_object('select-folder');
    this.selectFolderWidget = this.Window.get_object('select-folder');
    this.selectFolderOk = this.Window.get_object('ok-button');
    this.selectFolderCancel = this.Window.get_object('close-button');
    this.buttonInstall = this.Window.get_object('button-install');
    this.buttonInstallYes = this.Window.get_object('button-install-yes');
    this.buttonInstallNo = this.Window.get_object('button-install-no');
    this.labelInstall = this.Window.get_object('label-install');
    this.buttonFileChooser = this.Window.get_object('button-file-chooser');
    this.labelLocation = this.Window.get_object('label-location');
    this.installType = this.Window.get_object('install_type');
    this.entryIpAddress = this.Window.get_object('ip_address');
    this.entryPortNumber = this.Window.get_object('port_number');
    this.labelIpAddress = this.Window.get_object('label-ip-address');
    this.labelPortNumber = this.Window.get_object('label-port-number');
    //this.buttonFileChooser.set_current_folder(this.core_location);
    const core_loc = Gio.File.new_for_path(this.core_location);
    this.selectFolderWidget.set_current_folder(core_loc);
    this.installType.set_active(this.install_type);
    let theObjects = this.Window.get_objects();
    for (let i in theObjects) {
      let name = theObjects[i].get_name ? theObjects[i].get_name() : 'dummy';
      log(name);
      if (this[name] !== undefined) {
        log(this[name]);
        if (theObjects[i].class_path()[1].indexOf('GtkEntry') != -1) {
          this.initEntry(theObjects[i]);
        } else if (theObjects[i].class_path()[1].indexOf('GtkComboBoxText') != -1) {
          this.initComboBox(theObjects[i]);
        } else if (theObjects[i].class_path()[1].indexOf('GtkFileChooser') != -1) {
          this.initFileChooser(theObjects[i]);
        } else if (theObjects[i].class_path()[1].indexOf('GtkSwitch') != -1) {
          this.initSwitch(theObjects[i]);
        }
        this._configWidgets.push([ theObjects[i], name ]);
      }
    }
    this.installType.connect('changed', Lang.bind(this, function () {
      this.setMycroftCore(true);
    }));
    //this.installType.connect('draw', Lang.bind(this, function () {
    //  this.setMycroftCore();
    //}));
    this.buttonInstall.connect('clicked', Lang.bind(this, function () {
      this.isInstalled.show();
    }));
    this.buttonInstallYes.connect('clicked', Lang.bind(this, function () {
            // this.openUrl();
      this.runScript();
      this.isInstalled.hide();
    }));
    this.buttonInstallNo.connect('clicked', Lang.bind(this, function () {
      this.isInstalled.hide();
    }));
    
    this.buttonFileChooser.connect('clicked', () => {
    
      let dialog = new Gtk.FileChooserDialog({
        title: "Choose a file",
        action: Gtk.FileChooserAction.SELECT_FOLDER,
        modal: true,
        transient_for: this,
    });
    dialog.add_button('_Cancel', Gtk.ResponseType.CANCEL);
    dialog.add_button('_Open', Gtk.ResponseType.OK);

    dialog.connect("response", (dialog, response) => {
      if (response == Gtk.ResponseType.OK) {
          let folder = dialog.get_file().get_path();
          this.setCoreFolder(folder)
      }
      dialog.destroy();
  });
    
    dialog.show();
    });
  }
  openUrl() {
    var a = new GLib.TimeVal();
    let o = GLib.get_current_time(a);
    let url = 'https://github.com/MycroftAI/mycroft-core/';
    try {
      Gtk.show_uri(null, url, o);
    } catch (err) {
      let title = _('Can not open %s').format(url);
      log(err.message);
    }
  }
  runScript() {
    var e;
    try {
      let [ res, out ] = GLib.spawn_command_line_async('gnome-terminal -e ' + EXTENSIONDIR + '/shellscripts/packageInstall.sh');
    } catch (e) {
      throw e;
    }
  }
  setCoreFolder(v) {
    this.currentFolder = v;
    this.core_location = this.currentFolder;
  }
  getCoreFolder() {
    return location();
  }

  loadConfig() {
    this.Settings = Convenience.getSettings(MYCROFT_SETTINGS_SCHEMA);
    this.Settings.connect('changed', Lang.bind(this, function () {
      this.refreshUI();
    }));
  }
  setMycroftCore(fl) {
    if (fl) {
      this.install_type = this.installType.get_active();
    }
    switch (this.install_type) {
    case 0:
      this.mycroft_is_install = true;
      this.labelInstall.hide();
      this.buttonInstall.hide();
      this.buttonFileChooser.show();
      this.labelLocation.show();
                // port
      this.labelPortNumber.show();
      this.labelIpAddress.show();
      this.entryIpAddress.show();
      this.entryPortNumber.show();
      break;
                // case 1:
                //     if (fl) {
                //         this.mycroft_install_location = '/etc/mycroft';
                //     }
                //     this.mycroft_is_install = true;
                //     this.labelInstall.hide();
                //     this.buttonInstall.hide();
                //     this.buttonFileChooser.hide();
                //     this.labelLocation.hide();
                //     //port
                //     this.labelPortNumber.show();
                //     this.labelIpAddress.show();
                //     this.entryIpAddress.show();
                //     this.entryPortNumber.show();
                //     break;
    case 1:
      this.mycroft_is_install = false;
      this.labelInstall.show();
      this.buttonInstall.show();
      this.buttonFileChooser.hide();
      this.labelLocation.hide();
                // port
      this.labelPortNumber.hide();
      this.labelIpAddress.hide();
      this.entryIpAddress.hide();
      this.entryPortNumber.hide();
      break;
    case 2:
      this.mycroft_is_install = true;
      this.labelInstall.hide();
      this.buttonInstall.hide();
      this.buttonFileChooser.hide();
      this.labelLocation.hide();
                // port
      this.labelPortNumber.show();
      this.labelIpAddress.show();
      this.entryIpAddress.show();
      this.entryPortNumber.show();
      break;
    default:
                // donothing
    }
  }
  initEntry(theEntry) {
    let name = theEntry.get_name();

    theEntry.text = this[name];
    theEntry.connect('notify::text', Lang.bind(this, function () {
      log(this[name]);
      let key = arguments[0].text;
      this[name] = key;
    }));
  }
  initFileChooser(theFileChooser) {
    let name = theFileChooser.get_name();
    theFileChooser.connect('changed', Lang.bind(this, function () {
      this[name] = this.set_current_folder('/home/$USER/Mycroft-core');
    }));
  }

  initComboBox(theComboBox) {
    let name = theComboBox.get_name();
    theComboBox.connect('changed', Lang.bind(this, function () {
      this[name] = arguments[0].active;
    }));
  }
  initSwitch(theSwitch) {
    let name = theSwitch.get_name();
    theSwitch.connect('notify::active', Lang.bind(this, function () {
      this[name] = arguments[0].active;
    }));
  }
  refreshUI() {
    let config = this._configWidgets;
    for (let i in config) {
      if (config[i][0].active != this[config[i][1]]) {
        config[i][0].active = this[config[i][1]];
      }
    }
  }

  

  get position_in_panel() {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.get_enum(MYCROFT_POSITION_IN_PANEL_KEY);
  }

  set position_in_panel(v) {
    if (!this.Settings) {
      this.loadConfig();
    }
    this.Settings.set_enum(MYCROFT_POSITION_IN_PANEL_KEY, v);
  }
  get animation_status() {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.get_boolean(MYCROFT_ANIMATION_STATUS_KEY);
  }
  set animation_status(v) {
    if (!this.Settings) {
      this.loadConfig();
    }
    this.Settings.set_boolean(MYCROFT_ANIMATION_STATUS_KEY, v);
  }
  get core_location() {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.get_string(MYCROFT_CORE_LOCATION_KEY);
  }
  set core_location(v) {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.set_string(MYCROFT_CORE_LOCATION_KEY, v);
  }
  get install_type() {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.get_int(MYCROFT_INSTALL_TYPE_KEY);
  }
  set install_type(v) {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.set_int(MYCROFT_INSTALL_TYPE_KEY, v);
  }
  get mycroft_is_install() {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.get_boolean(MYCROFT_IS_INSTALL_KEY);
  }
  set mycroft_is_install(v) {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.set_boolean(MYCROFT_IS_INSTALL_KEY, v);
  }
  get ip_address() {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.get_string(MYCROFT_IP_ADDRESS_KEY);
  }
  set ip_address(v) {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.set_string(MYCROFT_IP_ADDRESS_KEY, v);
  }
  get port_number() {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.get_string(MYCROFT_PORT_NUMBER_KEY);
  }
  set port_number(v) {
    if (!this.Settings) {
      this.loadConfig();
    }
    return this.Settings.set_string(MYCROFT_PORT_NUMBER_KEY, v);
  }


});

function init() {
  Convenience.initTranslations('gnome-shell-extension-mycroft');
}

function buildPrefsWidget() {
  let prefs = new MycroftPrefsWidget();
  let widget = prefs.mainWidget;
  //widget.show_all();
  return widget;
}
