; Inno Setup Script for AFOMIS Help and Support
; Generated for AFOMIS Windows Desktop Application

[Setup]
; Application Information
AppName=AFOMIS Help and Support
AppVersion=1.0.0.1
AppPublisher=AFOMIS
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}}

; Installation Directories
DefaultDirName={autopf}\AFOMIS Help and Support
DefaultGroupName=AFOMIS Help and Support

; Output Configuration
OutputBaseFilename=AFOMIS-Setup-1.0.0
OutputDir=.

; Compression
Compression=lzma2/ultra64
SolidCompression=yes

; System Requirements
MinVersion=10.0
PrivilegesRequired=lowest

; Visual Style
WizardStyle=modern

; Uninstaller Configuration
UninstallDisplayIcon={app}\AFOMIS.exe
UninstallDisplayName=AFOMIS Help and Support

; Other Settings
DisableProgramGroupPage=no
DisableReadyPage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Main application files from PyInstaller dist folder
Source: "dist\AFOMIS\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Start Menu shortcut
Name: "{group}\AFOMIS Help and Support"; Filename: "{app}\AFOMIS.exe"; WorkingDir: "{app}"
Name: "{group}\Uninstall AFOMIS Help and Support"; Filename: "{uninstallexe}"

; Desktop shortcut
Name: "{autodesktop}\AFOMIS Help and Support"; Filename: "{app}\AFOMIS.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Run]
; Optional: Launch application after installation
Filename: "{app}\AFOMIS.exe"; Description: "{cm:LaunchProgram,AFOMIS Help and Support}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Remove any leftover files or directories not tracked by installer
Type: filesandordirs; Name: "{app}"

[Registry]
; Register in Add/Remove Programs with publisher info
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Uninstall{{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}}"; ValueType: string; ValueName: "Publisher"; ValueData: "AFOMIS"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Uninstall{{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}}"; ValueType: string; ValueName: "DisplayName"; ValueData: "AFOMIS Help and Support"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Uninstall{{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}}"; ValueType: string; ValueName: "DisplayVersion"; ValueData: "1.0.0"; Flags: uninsdeletekey
