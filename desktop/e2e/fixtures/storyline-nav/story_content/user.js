window.InitUserScripts = function()
{
var player = GetPlayer();
var object = player.object;
var once = player.once;
var addToTimeline = player.addToTimeline;
var setVar = player.SetVar;
var getVar = player.GetVar;
var update = player.update;
var pointerX = player.pointerX;
var pointerY = player.pointerY;
var showPointer = player.showPointer;
var hidePointer = player.hidePointer;
var slideWidth = player.slideWidth;
var slideHeight = player.slideHeight;
var getKeyDown = player.getKeyDown;
var keydown = player.keydown;
var keyup = player.keyup;
window.Script1 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newCDSLibrary_ChiefComplaint = player.GetVar("CDSLibrary_ChiefComplaint").trim();

// set variable to new trimmed variable
player.SetVar("CDSLibrary_ChiefComplaint", newCDSLibrary_ChiefComplaint);
}

window.Script2 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script3 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script4 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script5 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script6 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newRegisterPatient_ChiefComplaint = player.GetVar("RegisterPatient_ChiefComplaint").trim();

// set variable to new trimmed variable
player.SetVar("RegisterPatient_ChiefComplaint", newRegisterPatient_ChiefComplaint);
}

window.Script7 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newRegisterPatient_Unit = player.GetVar("RegisterPatient_Unit").trim();

// set variable to new trimmed variable
player.SetVar("RegisterPatient_Unit", newRegisterPatient_Unit);
}

window.Script8 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newRegisterPatient_PhoneNumber = player.GetVar("RegisterPatient_PhoneNumber").trim();

// set variable to new trimmed variable
player.SetVar("RegisterPatient_PhoneNumber", newRegisterPatient_PhoneNumber);
}

window.Script9 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script10 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script11 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newManuallyRegister_FirstName = player.GetVar("ManuallyRegister_FirstName").trim();

// set variable to new trimmed variable
player.SetVar("ManuallyRegister_FirstName", newManuallyRegister_FirstName);
}

window.Script12 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newManuallyRegister_MiddleName = player.GetVar("ManuallyRegister_MiddleName").trim();

// set variable to new trimmed variable
player.SetVar("ManuallyRegister_MiddleName", newManuallyRegister_MiddleName);
}

window.Script13 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newManuallyRegister_LastName = player.GetVar("ManuallyRegister_LastName").trim();

// set variable to new trimmed variable
player.SetVar("ManuallyRegister_LastName", newManuallyRegister_LastName);
}

window.Script14 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newManuallyRegister_ChiefComplaint = player.GetVar("ManuallyRegister_ChiefComplaint").trim();

// set variable to new trimmed variable
player.SetVar("ManuallyRegister_ChiefComplaint", newManuallyRegister_ChiefComplaint);
}

window.Script15 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newManuallyRegister_Unit = player.GetVar("ManuallyRegister_Unit").trim();

// set variable to new trimmed variable
player.SetVar("ManuallyRegister_Unit", newManuallyRegister_Unit);
}

window.Script16 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newManuallyRegister_PhoneNumber = player.GetVar("ManuallyRegister_PhoneNumber").trim();

// set variable to new trimmed variable
player.SetVar("ManuallyRegister_PhoneNumber", newManuallyRegister_PhoneNumber);
}

window.Script17 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newMedicDNBI_Anxiety = player.GetVar("MedicDNBI_Anxiety").trim();

// set variable to new trimmed variable
player.SetVar("MedicDNBI_Anxiety", newMedicDNBI_Anxiety);
}

window.Script18 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newMedicDNBI_Appendectomy = player.GetVar("MedicDNBI_Appendectomy").trim();

// set variable to new trimmed variable
player.SetVar("MedicDNBI_Appendectomy", newMedicDNBI_Appendectomy);
}

window.Script19 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newMedicDNBI_Known = player.GetVar("MedicDNBI_Known").trim();

// set variable to new trimmed variable
player.SetVar("MedicDNBI_Known", newMedicDNBI_Known);
}

window.Script20 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newMedicDNBI_Lexapro = player.GetVar("MedicDNBI_Lexapro").trim();

// set variable to new trimmed variable
player.SetVar("MedicDNBI_Lexapro", newMedicDNBI_Lexapro);
}

window.Script21 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script22 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script23 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newMedicDNBI_FamilyHistory = player.GetVar("MedicDNBI_FamilyHistory").trim();

// set variable to new trimmed variable
player.SetVar("MedicDNBI_FamilyHistory", newMedicDNBI_FamilyHistory);
}

window.Script24 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script25 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script26 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newMedicDNBI_EarPain = player.GetVar("MedicDNBI_EarPain").trim();

// set variable to new trimmed variable
player.SetVar("MedicDNBI_EarPain", newMedicDNBI_EarPain);
}

window.Script27 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script28 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script29 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script30 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script31 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script32 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script33 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script34 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script35 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script36 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script37 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_Comment1 = player.GetVar("ProviderDNBI_Comment1").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_Comment1", newProviderDNBI_Comment1);
}

window.Script38 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_EarsExamComment = player.GetVar("ProviderDNBI_EarsExamComment").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_EarsExamComment", newProviderDNBI_EarsExamComment);
}

window.Script39 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_ProcedurePerformed = player.GetVar("ProviderDNBI_ProcedurePerformed").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_ProcedurePerformed", newProviderDNBI_ProcedurePerformed);
}

window.Script40 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_ProcedureNote = player.GetVar("ProviderDNBI_ProcedureNote").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_ProcedureNote", newProviderDNBI_ProcedureNote);
}

window.Script41 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_DiffDiagnosis = player.GetVar("ProviderDNBI_DiffDiagnosis").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_DiffDiagnosis", newProviderDNBI_DiffDiagnosis);
}

window.Script42 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_Diagnosis = player.GetVar("ProviderDNBI_Diagnosis").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_Diagnosis", newProviderDNBI_Diagnosis);
}

window.Script43 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_DnI = player.GetVar("ProviderDNBI_DnI").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_DnI", newProviderDNBI_DnI);
}

window.Script44 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_Plan = player.GetVar("ProviderDNBI_Plan").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_Plan", newProviderDNBI_Plan);
}

window.Script45 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script46 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script47 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_DischargeInstructions = player.GetVar("ProviderDNBI_DischargeInstructions").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_DischargeInstructions", newProviderDNBI_DischargeInstructions);
}

window.Script48 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newProviderDNBI_Password = player.GetVar("ProviderDNBI_Password").trim();

// set variable to new trimmed variable
player.SetVar("ProviderDNBI_Password", newProviderDNBI_Password);
}

window.Script49 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script50 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script51 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script52 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script53 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newUploadingDocs_DocType = player.GetVar("UploadingDocs_DocType").trim();

// set variable to new trimmed variable
player.SetVar("UploadingDocs_DocType", newUploadingDocs_DocType);
}

window.Script54 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newUploadingDocs_Title = player.GetVar("UploadingDocs_Title").trim();

// set variable to new trimmed variable
player.SetVar("UploadingDocs_Title", newUploadingDocs_Title);
}

window.Script55 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script56 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script57 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script58 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script59 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script60 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script61 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script62 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script63 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script64 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script65 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script66 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script67 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newPharmacy_Comments = player.GetVar("Pharmacy_Comments").trim();

// set variable to new trimmed variable
player.SetVar("Pharmacy_Comments", newPharmacy_Comments);
}

window.Script68 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script69 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script70 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newPharmacy_Comments = player.GetVar("Pharmacy_Comments").trim();

// set variable to new trimmed variable
player.SetVar("Pharmacy_Comments", newPharmacy_Comments);
}

window.Script71 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script72 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script73 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script74 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script75 = function()
{
  // gets the player object
const player = GetPlayer();

// access the variable and remove spaces from beginning and end
let newPharmacy_Comments = player.GetVar("Pharmacy_Comments").trim();

// set variable to new trimmed variable
player.SetVar("Pharmacy_Comments", newPharmacy_Comments);
}

window.Script76 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script77 = function()
{
  document.querySelector(".video-transcript").click();
}

window.Script78 = function()
{
  document.querySelector('.modern-video-controls').style.display = 'none';
document.querySelector('[id*="-playpause"]').ariaHidden = true;
document.querySelector('[id*="-mute"]').ariaHidden = true;
document.querySelector('[id*="-volume"]').ariaHidden = true;
document.querySelector('[id*="-captions"]').ariaHidden = true;
document.querySelector('[id*="-transcript"]').ariaHidden = true;
document.querySelector('[id*="-pip"]').ariaHidden = true;
document.querySelector('[id*="-fullscreen"]').ariaHidden = true;
document.querySelector('[id*="-seekbar"]').ariaHidden = true;
document.querySelector('[aria-controls*="speedcontrol"]').ariaHidden = true;
}

window.Script79 = function()
{
  document.querySelector(".video-transcript").click();
}

};
