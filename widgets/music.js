'use strict';

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const MPRIS_PLAYER_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

const MAX_STRING_LENGTH = 40;

export const GlassMusicWidget = GObject.registerClass(
class GlassMusicWidget extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'glass-card glass-music-card',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        this._players = new Map();
        this._activePlayer = null;
        this._dbusProxy = null;
        this._proxySignalId = null;
        this._busWatchId = null;
        this._nameAppearedId = null;

        this._buildUI();
        this._setupDBusWatch();
    }

    _buildUI() {
        // Main horizontal layout with album art and info side by side
        this._mainBox = new St.BoxLayout({
            vertical: false,
            style_class: 'glass-music-main',
        });
        this.add_child(this._mainBox);

        // Album art (circular)
        this._albumArtBin = new St.Bin({
            style_class: 'glass-music-album-art-bin',
        });
        this._mainBox.add_child(this._albumArtBin);

        this._albumArt = new St.Icon({
            style_class: 'glass-music-album-art',
            icon_name: 'folder-music-symbolic',
            icon_size: 64,
        });
        this._albumArtBin.set_child(this._albumArt);

        // Right side with track info and controls
        this._rightBox = new St.BoxLayout({
            vertical: true,
            style_class: 'glass-music-right',
            x_expand: true,
        });
        this._mainBox.add_child(this._rightBox);

        // Track info
        this._trackLabel = new St.Label({
            style_class: 'glass-music-track',
            text: _('No track playing'),
        });
        this._rightBox.add_child(this._trackLabel);

        this._artistLabel = new St.Label({
            style_class: 'glass-music-artist',
            text: '',
        });
        this._rightBox.add_child(this._artistLabel);

        // Progress bar
        this._progressBox = new St.BoxLayout({
            style_class: 'glass-music-progress-box',
            vertical: false,
        });
        this._rightBox.add_child(this._progressBox);

        this._currentTimeLabel = new St.Label({
            style_class: 'glass-music-time',
            text: '0:00',
        });
        this._progressBox.add_child(this._currentTimeLabel);

        this._progressBar = new St.Widget({
            style_class: 'glass-music-progress-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._progressBox.add_child(this._progressBar);

        this._totalTimeLabel = new St.Label({
            style_class: 'glass-music-time',
            text: '0:00',
        });
        this._progressBox.add_child(this._totalTimeLabel);

        // Controls
        this._controlsBox = new St.BoxLayout({
            style_class: 'glass-music-controls',
            x_align: Clutter.ActorAlign.START,
        });
        this._rightBox.add_child(this._controlsBox);

        this._prevButton = new St.Button({
            style_class: 'glass-music-button',
            child: new St.Icon({
                icon_name: 'media-skip-backward-symbolic',
                icon_size: 18,
            }),
        });
        this._prevButton.connect('clicked', () => this._onPrevious());
        this._controlsBox.add_child(this._prevButton);

        this._playPauseButton = new St.Button({
            style_class: 'glass-music-button glass-music-button-play',
            child: new St.Icon({
                icon_name: 'media-playback-start-symbolic',
                icon_size: 20,
            }),
        });
        this._playPauseButton.connect('clicked', () => this._onPlayPause());
        this._controlsBox.add_child(this._playPauseButton);

        this._nextButton = new St.Button({
            style_class: 'glass-music-button',
            child: new St.Icon({
                icon_name: 'media-skip-forward-symbolic',
                icon_size: 18,
            }),
        });
        this._nextButton.connect('clicked', () => this._onNext());
        this._controlsBox.add_child(this._nextButton);

        // Player name badge
        this._playerLabel = new St.Label({
            style_class: 'glass-music-player-badge',
            text: '',
        });
        this._controlsBox.add_child(this._playerLabel);

        // Initially hide if no player
        this._setPlayerActive(false);
    }

    _setupDBusWatch() {
        // Get existing players first
        Gio.DBus.session.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, result) => {
                try {
                    const variant = connection.call_finish(result);
                    const [names] = variant.deep_unpack();
                    for (const name of names) {
                        if (name.startsWith(MPRIS_PLAYER_PREFIX))
                            this._addPlayer(name);
                    }
                } catch (e) {
                    console.error(`glass-widgets: failed to list DBus names: ${e}`);
                }
            }
        );
        
        // Watch for new players appearing
        this._nameAppearedId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (connection, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deep_unpack();
                if (name.startsWith(MPRIS_PLAYER_PREFIX)) {
                    if (newOwner && newOwner.length > 0)
                        this._addPlayer(name);
                    else if (!newOwner || newOwner.length === 0)
                        this._removePlayer(name);
                }
            }
        );
    }

    _onNameAppeared(name, owner) {
        // No longer used - kept for compatibility
    }

    _onNameVanished(name) {
        // No longer used - kept for compatibility
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const proxyWrapper = Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.NONE,
            null,
            busName,
            '/org/mpris/MediaPlayer2',
            MPRIS_PLAYER_INTERFACE,
            null,
            (source, result) => {
                try {
                    const proxy = Gio.DBusProxy.new_finish(result);
                    this._players.set(busName, proxy);

                    proxy.connect('g-properties-changed', () => {
                        if (this._activePlayer === busName)
                            this._updateDisplay();
                    });

                    // Set as active player if we don't have one
                    if (!this._activePlayer)
                        this._setActivePlayer(busName);

                } catch (e) {
                    console.error(`glass-widgets: failed to create proxy for ${busName}: ${e}`);
                }
            }
        );
    }

    _removePlayer(busName) {
        this._players.delete(busName);

        if (this._activePlayer === busName) {
            // Switch to another player or deactivate
            const nextPlayer = this._players.keys().next().value;
            if (nextPlayer)
                this._setActivePlayer(nextPlayer);
            else
                this._setActivePlayer(null);
        }
    }

    _setActivePlayer(busName) {
        this._activePlayer = busName;
        if (busName) {
            this._setPlayerActive(true);
            this._updateDisplay();
        } else {
            this._setPlayerActive(false);
        }
    }

    _setPlayerActive(active) {
        if (active) {
            this.show();
        } else {
            this.hide();
        }
    }

    _updateDisplay() {
        if (!this._activePlayer)
            return;

        const proxy = this._players.get(this._activePlayer);
        if (!proxy)
            return;

        // Player name badge
        const playerName = this._activePlayer
            .replace(MPRIS_PLAYER_PREFIX, '')
            .split('.')[0];
        this._playerLabel.text = playerName.toUpperCase();

        // Metadata
        const metadata = proxy.get_cached_property('Metadata');
        if (metadata) {
            const metadataDict = metadata.deep_unpack();

            const title = this._truncate(
                metadataDict['xesam:title']?.unpack() || _('Unknown Track'), 35
            );
            const artists = metadataDict['xesam:artist']?.deep_unpack() || [];
            const artist = this._truncate(
                artists.length > 0 ? artists.join(', ') : _('Unknown Artist'), 35
            );
            const artUrl = metadataDict['mpris:artUrl']?.unpack() || '';
            const length = metadataDict['mpris:length']?.unpack() || 0;

            this._trackLabel.text = title;
            this._artistLabel.text = artist;
            
            // Update total time
            if (length > 0) {
                const totalSecs = Math.floor(length / 1000000);
                this._totalTimeLabel.text = this._formatTime(totalSecs);
            }

            // Album art
            if (artUrl) {
                try {
                    if (artUrl.startsWith('file://')) {
                        const file = Gio.File.new_for_uri(artUrl);
                        const icon = new Gio.FileIcon({file});
                        this._albumArt.set_gicon(icon);
                    } else if (artUrl.startsWith('http://') || artUrl.startsWith('https://')) {
                        this._albumArt.icon_name = 'folder-music-symbolic';
                    } else {
                        this._albumArt.icon_name = 'folder-music-symbolic';
                    }
                } catch (e) {
                    this._albumArt.icon_name = 'folder-music-symbolic';
                }
            } else {
                this._albumArt.icon_name = 'folder-music-symbolic';
            }
        }
        
        // Update position
        this._updatePosition();

        // Playback status
        const playbackStatus = proxy.get_cached_property('PlaybackStatus');
        if (playbackStatus) {
            const status = playbackStatus.unpack();
            const isPlaying = status === 'Playing';
            this._playPauseButton.child.icon_name = isPlaying
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
        }

        // Button sensitivity
        const canGoPrevious = proxy.get_cached_property('CanGoPrevious')?.unpack() ?? false;
        const canGoNext = proxy.get_cached_property('CanGoNext')?.unpack() ?? false;
        const canPlay = proxy.get_cached_property('CanPlay')?.unpack() ?? false;
        const canPause = proxy.get_cached_property('CanPause')?.unpack() ?? false;

        this._prevButton.reactive = canGoPrevious;
        this._prevButton.opacity = canGoPrevious ? 255 : 100;
        this._nextButton.reactive = canGoNext;
        this._nextButton.opacity = canGoNext ? 255 : 100;
        this._playPauseButton.reactive = canPlay || canPause;
        this._playPauseButton.opacity = (canPlay || canPause) ? 255 : 100;
    }

    _truncate(text, maxLen = MAX_STRING_LENGTH) {
        if (text.length > maxLen)
            return `${text.substring(0, maxLen)}…`;
        return text;
    }
    
    _formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    
    _updatePosition() {
        if (!this._activePlayer)
            return;

        const proxy = this._players.get(this._activePlayer);
        if (!proxy)
            return;

        const position = proxy.get_cached_property('Position');
        if (position) {
            const positionSecs = Math.floor(position.unpack() / 1000000);
            this._currentTimeLabel.text = this._formatTime(positionSecs);
        }
    }

    _onPlayPause() {
        if (!this._activePlayer)
            return;

        const proxy = this._players.get(this._activePlayer);
        if (!proxy)
            return;

        proxy.call(
            'PlayPause',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
    }

    _onNext() {
        if (!this._activePlayer)
            return;

        const proxy = this._players.get(this._activePlayer);
        if (!proxy)
            return;

        proxy.call(
            'Next',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
    }

    _onPrevious() {
        if (!this._activePlayer)
            return;

        const proxy = this._players.get(this._activePlayer);
        if (!proxy)
            return;

        proxy.call(
            'Previous',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
    }

    destroy() {
        if (this._nameAppearedId) {
            Gio.DBus.session.signal_unsubscribe(this._nameAppearedId);
            this._nameAppearedId = null;
        }
        if (this._busWatchId) {
            Gio.bus_unwatch_name(this._busWatchId);
            this._busWatchId = null;
        }
        this._players.clear();
        this._activePlayer = null;
        super.destroy();
    }
});
