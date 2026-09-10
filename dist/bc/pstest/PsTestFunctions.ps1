Param(
    [Parameter(Mandatory=$true)]
    [string] $clientDllPath,
    [Parameter(Mandatory=$true)]
    [string] $newtonSoftDllPath,
    [string] $clientContextScriptPath = $null
)

$antiSSRFdll = Join-Path ([System.IO.Path]::GetDirectoryName($clientDllPath)) 'Microsoft.Internal.AntiSSRF.dll'

# Load DLL's
Add-type -Path $newtonSoftDllPath
if (Test-Path $antiSSRFdll) {
    $Threading = [Reflection.Assembly]::LoadFile((Join-Path ([System.IO.Path]::GetDirectoryName($clientDllPath)) 'System.Threading.Tasks.Extensions.dll'))
    $onAssemblyResolve = [System.ResolveEventHandler] {
        param($sender, $e)
        if ($e.Name -like "System.Threading.Tasks.Extensions, Version=*, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51") {
            return $Threading
        }
        return $null
    }
    [System.AppDomain]::CurrentDomain.add_AssemblyResolve($onAssemblyResolve)
    try {
        Add-Type -Path $antiSSRFdll
    }
    finally {
        [System.AppDomain]::CurrentDomain.remove_AssemblyResolve($onAssemblyResolve)
    }
}
Add-type -Path $clientDllPath

if (!($clientContextScriptPath)) {
    $clientContextScriptPath = Join-Path $PSScriptRoot "ClientContext.ps1"
}

. $clientContextScriptPath -clientDllPath $clientDllPath

function New-ClientContext {
    Param(
        [Parameter(Mandatory=$true)]
        [string] $serviceUrl,
        [ValidateSet('Windows','NavUserPassword','AAD')]
        [string] $auth='NavUserPassword',
        [Parameter(Mandatory=$false)]
        [pscredential] $credential,
        [timespan] $interactionTimeout = [timespan]::FromMinutes(10),
        [string] $culture = "en-US",
        [string] $timezone = "",
        [switch] $debugMode
    )

    if ($auth -eq "Windows") {
        $clientContext = [ClientContext]::new($serviceUrl, $interactionTimeout, $culture, $timezone)
    }
    elseif ($auth -eq "NavUserPassword") {
        if ($Credential -eq $null -or $credential -eq [System.Management.Automation.PSCredential]::Empty) {
            throw "You need to specify credentials if using NavUserPassword authentication"
        }
        $clientContext = [ClientContext]::new($serviceUrl, $credential, $interactionTimeout, $culture, $timezone)
    }
    elseif ($auth -eq "AAD") {

        if ($Credential -eq $null -or $credential -eq [System.Management.Automation.PSCredential]::Empty) {
            throw "You need to specify credentials (Username and AccessToken) if using AAD authentication"
        }
        $accessToken = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password))
        $clientContext = [ClientContext]::new($serviceUrl, $accessToken, $interactionTimeout, $culture, $timezone)
    }
    else {
        throw "Unsupported authentication setting"
    }
    if ($clientContext) {
        $clientContext.debugMode = $debugMode
    }
    return $clientContext
}

function Remove-ClientContext {
    Param(
        [ClientContext] $clientContext
    )
    if ($clientContext) {
        $clientContext.Dispose()
    }
}

function Dump-ClientContext {
    Param(
        [ClientContext] $clientContext
    )
    if ($clientContext) {
        $clientContext.GetAllForms() | % {
            $formInfo = $clientContext.GetFormInfo($_)
            if ($formInfo) {
                Write-Host -ForegroundColor Yellow "Title: $($formInfo.title)"
                Write-Host -ForegroundColor Yellow "Title: $($formInfo.identifier)"
                $formInfo.controls | ConvertTo-Json -Depth 99 | Out-Host
            }
        }
    }
}

function Set-ExtensionId
(
    [string] $ExtensionId,
    [ClientContext] $ClientContext,
    [switch] $debugMode,
    $Form
)
{
    if(!$ExtensionId)
    {
        return
    }
    
    if ($debugMode) {
        Write-Host "Setting Extension Id $ExtensionId"
    }
    $extensionIdControl = $ClientContext.GetControlByName($Form, "ExtensionId")
    $ClientContext.SaveValue($extensionIdControl, $ExtensionId)
}

function Set-RequiredTestIsolation
(
    [ValidateSet('None','Disabled','Codeunit','Function')]
    [string] $RequiredTestIsolation,
    [ClientContext] $ClientContext,
    [switch] $debugMode,
    $Form
)
{
    if ($debugMode) {
        Write-Host "Setting Required Test Isolation $RequiredTestIsolation"
    }

    $TestIsolationValues = @{
        None = 0
        Disabled = 1
        Codeunit = 2
        Function = 3
    }
    $requiredTestIsolationControl = $ClientContext.GetControlByName($Form, "RequiredTestIsolation")
    $ClientContext.SaveValue($requiredTestIsolationControl, $TestIsolationValues[$RequiredTestIsolation])
}

function Set-TestType
(
    [ValidateSet('UnitTest','IntegrationTest','Uncategorized')]
    [string] $TestType,
    [ClientContext] $ClientContext,
    [switch] $debugMode,
    $Form
)
{
    if ($debugMode) {
        Write-Host "Setting Test Type $TestType"
    }

    $TypeValues = @{
        UnitTest = 1
        IntegrationTest = 2
        Uncategorized = 3
    }
    $testTypeControl = $ClientContext.GetControlByName($Form, "TestType")
    $ClientContext.SaveValue($testTypeControl, $TypeValues[$TestType])
}

function Set-TestCodeunitRange
(
    [string] $testCodeunitRange,
    [ClientContext] $ClientContext,
    [switch] $debugMode,
    $Form
) {
    Write-Host "Setting test codeunit range '$testCodeunitRange'"
    if (!$testCodeunitRange) { return }
    if ($testCodeunitRange -eq "*") { $testCodeunitRange = "0.." }

    if ($debugMode) {
        Write-Host "Setting test codeunit range '$testCodeunitRange'"
    }
    $testCodeunitRangeControl = $ClientContext.GetControlByName($Form, "TestCodeunitRangeFilter")
    if ($null -eq $testCodeunitRangeControl) { 
        if ($debugMode) { Write-Host "Test codeunit range control not found on test page" }
        return 
    }
    $ClientContext.SaveValue($testCodeunitRangeControl, $testCodeunitRange)
}

function Set-TestRunnerCodeunitId
(
    [string] $testRunnerCodeunitId,
    [ClientContext] $ClientContext,
    [switch] $debugMode,
    $Form
)
{
    if(!$testRunnerCodeunitId)
    {
        return
    }
    
    if ($debugMode) {
        Write-Host "Setting Test Runner Codeunit Id $testRunnerCodeunitId"
    }
    $testRunnerCodeunitIdControl = $ClientContext.GetControlByName($Form, "TestRunnerCodeunitId")
    $ClientContext.SaveValue($testRunnerCodeunitIdControl, $testRunnerCodeunitId)
}

function Set-RunFalseOnDisabledTests
(
    [ClientContext] $ClientContext,
    [array] $DisabledTests,
    [switch] $debugMode,
    $Form
)
{
    if(!$DisabledTests)
    {
        return
    }

    $removeTestMethodControl = $ClientContext.GetControlByName($Form, "DisableTestMethod")
    foreach($disabledTestMethod in $DisabledTests)
    {
        $disabledTestMethod.method | ForEach-Object {
            if ($disabledTestMethod.codeunitName.IndexOf(',') -ge 0) {
                Write-Host "Warning: Cannot disable tests in codeunits with a comma in the name ($($disabledTestMethod.codeunitName):$_)"
            }
            else {
                if ($debugMode) {
                    Write-Host "Disabling Test $($disabledTestMethod.codeunitName):$_"
                }
                $testKey = "$($disabledTestMethod.codeunitName),$_"
                $ClientContext.SaveValue($removeTestMethodControl, $testKey)
            }
        }
    }
}

function Set-CCTrackingType
{
    param (
        [ValidateSet('Disabled', 'PerRun', 'PerCodeunit', 'PerTest')]
        [string] $Value,
        [ClientContext] $ClientContext,
        $Form
    )
    $TypeValues = @{
        Disabled = 0
        PerRun = 1
        PerCodeunit=2
        PerTest=3
    }
    $suiteControl = $ClientContext.GetControlByName($Form, "CCTrackingType")
    $ClientContext.SaveValue($suiteControl, $TypeValues[$Value])
}

function Set-CCExporterID
{
    param (
        [string] $Value,
        [ClientContext] $ClientContext,
        $Form
    )
    if($Value){
        $suiteControl = $ClientContext.GetControlByName($Form, "CCExporterID");
        $ClientContext.SaveValue($suiteControl, $Value)
    }
}

function Set-CCProduceCodeCoverageMap
{

    param (
        [ValidateSet('Disabled', 'PerCodeunit', 'PerTest')]
        [string] $Value,
        [ClientContext] $ClientContext,
        $Form
    )
    $TypeValues = @{
        Disabled = 0
        PerCodeunit = 1
        PerTest=2
    }
    $suiteControl = $ClientContext.GetControlByName($Form, "CCMap")
    $ClientContext.SaveValue($suiteControl, $TypeValues[$Value])
}

function Clear-CCResults
{
    param (
        [ClientContext] $ClientContext,
        $Form
    )
    $ClientContext.InvokeAction($ClientContext.GetActionByName($Form, "ClearCodeCoverage"))
}

function CollectCoverageResults {
    param (
        [ValidateSet('PerRun', 'PerCodeunit', 'PerTest')]
        [string] $TrackingType,
        [string] $OutputPath,
        [switch] $DisableSSLVerification,
        [ValidateSet('Windows','NavUserPassword','AAD')]
        [string] $AutorizationType = $script:DefaultAuthorizationType,
        [Parameter(Mandatory=$false)]
        [pscredential] $Credential,
        [Parameter(Mandatory=$true)]
        [string] $ServiceUrl,
        [string] $CodeCoverageFilePrefix
    )
    try{
        $clientContext = Open-ClientSessionWithWait -DisableSSLVerification:$DisableSSLVerification -AuthorizationType $AutorizationType -Credential $Credential -ServiceUrl $ServiceUrl
        $form = Open-TestForm -TestPage $TestPage -ClientContext $clientContext
        do {
            $clientContext.InvokeAction($clientContext.GetActionByName($form, "GetCodeCoverage"))

            $CCResultControl = $clientContext.GetControlByName($form, "CCResultsCSVText")
            $CCInfoControl = $clientContext.GetControlByName($form, "CCInfo")
            $CCResult = $CCResultControl.StringValue
            $CCInfo = $CCInfoControl.StringValue
            if($CCInfo -ne $script:CCCollectedResult){
                $CCInfo = $CCInfo -replace ",","-"
                $CCOutputFilename = $CodeCoverageFilePrefix +"_$CCInfo.dat"
                Write-Host "Storing coverage results of $CCCodeunitId in:  $OutputPath\$CCOutputFilename"
                Set-Content -Path "$OutputPath\$CCOutputFilename" -Value $CCResult
            }
        } while ($CCInfo -ne $script:CCCollectedResult)
       
        if($ProduceCodeCoverageMap -ne 'Disabled') {
            $codeCoverageMapPath = Join-Path $OutputPath "TestCoverageMap"
            SaveCodeCoverageMap -OutputPath $codeCoverageMapPath  -DisableSSLVerification:$DisableSSLVerification -AutorizationType $AutorizationType -Credential $Credential -ServiceUrl $ServiceUrl
        }

        $clientContext.CloseForm($form)
    }
    finally{
        if($clientContext){
            $clientContext.Dispose()
        }
    }
}

function SaveCodeCoverageMap {
    param (
        [string] $OutputPath,
        [switch] $DisableSSLVerification,
        [ValidateSet('Windows','NavUserPassword','AAD')]
        [string] $AutorizationType = $script:DefaultAuthorizationType,
        [Parameter(Mandatory=$false)]
        [pscredential] $Credential,
        [Parameter(Mandatory=$true)]
        [string] $ServiceUrl
    )
    try{
        $clientContext = Open-ClientSessionWithWait -DisableSSLVerification:$DisableSSLVerification -AuthorizationType $AutorizationType -Credential $Credential -ServiceUrl $ServiceUrl
        $form = Open-TestForm -TestPage $TestPage -ClientContext $clientContext

        $clientContext.InvokeAction($clientContext.GetActionByName($form, "GetCodeCoverageMap"))

        $CCResultControl = $clientContext.GetControlByName($form, "CCMapCSVText")
        $CCMap = $CCResultControl.StringValue

        if (-not (Test-Path $OutputPath))
        {
            New-Item $OutputPath -ItemType Directory
        }
        
        $codeCoverageMapFileName = Join-Path $codeCoverageMapPath "TestCoverageMap.txt"
        if (-not (Test-Path $codeCoverageMapFileName))
        {
            New-Item $codeCoverageMapFileName -ItemType File
        }

        Add-Content -Path $codeCoverageMapFileName -Value $CCMap

        $clientContext.CloseForm($form)
    }
    finally{
        if($clientContext){
            $clientContext.Dispose()
        }
    }
}

function Get-Tests {
    Param(
        [ClientContext] $clientContext,
        [int] $testPage = 130409,
        [string] $testSuite = "DEFAULT",
        [string] $testCodeunit = "*",
        [string] $testCodeunitRange = "",
        [string] $extensionId = "",
        [string] $requiredTestIsolation = "",
        [string] $testType = "",
        [string] $testRunnerCodeunitId = "",
        [array]  $disabledtests = @(),
        [switch] $debugMode,
        [switch] $ignoreGroups,
        [switch] $connectFromHost
    )

    if ($testPage -eq 130455) {
        $LineTypeAdjust = 1
    }
    else {
        $lineTypeAdjust = 0
        if ($disabledTests) {
            throw "Specifying disabledTests is not supported when using the C/AL test runner"
        }
        if ($extensionId) {
            throw "Specifying extensionId is not supported when using the C/AL test runner"
        }
        if ($testRunnerCodeunitId) {
            throw "Specifying testRunnerCodeunitId is not supported when using the C/AL test runner"
        }
    }

    if ($debugMode) {
        Write-Host "Get-Tests, open page $testpage"
    }

    $form = $clientContext.OpenForm($testPage)
    if (!($form)) {
        throw "Cannot open page $testPage. You might need to import the test toolkit and/or remove the folder $PSScriptRoot and retry. You might also have URL or Company name wrong."
    }
    if ($extensionId -ne "" -and $testSuite -ne "DEFAULT") {
        throw "You cannot specify testSuite and extensionId at the same time"
    }

    $suiteControl = $clientContext.GetControlByName($form, "CurrentSuiteName")
    $clientContext.SaveValue($suiteControl, $testSuite)

    if ($testPage -eq 130455) {
        Set-ExtensionId -ExtensionId $extensionId -Form $form -ClientContext $clientContext -debugMode:$debugMode
        if (![string]::IsNullOrEmpty($requiredTestIsolation)) {
            Set-RequiredTestIsolation -RequiredTestIsolation $requiredTestIsolation -Form $form -ClientContext $clientContext -debugMode:$debugMode
        }
        if (![string]::IsNullOrEmpty($testType)) {
            Set-TestType -TestType $testType -Form $form -ClientContext $clientContext -debugMode:$debugMode
        }
        Set-TestCodeunitRange -testCodeunitRange $testCodeunitRange -Form $form -ClientContext $clientContext -debugMode:$debugMode
        Set-TestRunnerCodeunitId -TestRunnerCodeunitId $testRunnerCodeunitId -Form $form -ClientContext $clientContext -debugMode:$debugMode
        Set-RunFalseOnDisabledTests -DisabledTests $DisabledTests -Form $form -ClientContext $clientContext -debugMode:$debugMode
        $clientContext.InvokeAction($clientContext.GetActionByName($form, 'ClearTestResults'))
    }

    $repeater = $clientContext.GetControlByType($form, [Microsoft.Dynamics.Framework.UI.Client.ClientRepeaterControl])
    $index = 0
    if ($testPage -eq 130455) {
        if ($debugMode) {
            Write-Host "Offset: $($repeater.offset)"
        }
        $clientContext.SelectFirstRow($repeater)
        $clientContext.Refresh($repeater)
        if ($debugMode) {
            Write-Host "Offset: $($repeater.offset)"
        }
    }

    $Tests = @()
    $group = $null
    while ($true)
    {
        $validationResults = $form.validationResults
        if ($validationResults) {
            throw "Validation errors occured. Error is: $($validationResults | ConvertTo-Json -Depth 99)"
        }

        if ($debugMode) {
            Write-Host "Index:  $index, Offset: $($repeater.Offset), Count:  $($repeater.DefaultViewport.Count)"
        }        
        if ($index -ge ($repeater.Offset + $repeater.DefaultViewport.Count))
        {
            if ($debugMode) {
                Write-Host "Scroll"
            }
            $clientContext.ScrollRepeater($repeater, 1)
            if ($debugMode) {
                Write-Host "Index:  $index, Offset: $($repeater.Offset), Count:  $($repeater.DefaultViewport.Count)"
            }        
        }
        $rowIndex = $index - $repeater.Offset
        $index++
        if ($rowIndex -ge $repeater.DefaultViewport.Count)
        {
            if ($debugMode) {
                Write-Host "Breaking - rowIndex: $rowIndex"
            }
            break 
        }
        $row = $repeater.DefaultViewport[$rowIndex]
        $lineTypeControl = $clientContext.GetControlByName($row, "LineType")
        $lineType = "$(([int]$lineTypeControl.StringValue) + $lineTypeAdjust)"
        $name = $clientContext.GetControlByName($row, "Name").StringValue
        $codeUnitId = $clientContext.GetControlByName($row, "TestCodeunit").StringValue
        if ($testPage -eq 130455) {
            $run = $clientContext.GetControlByName($row, "Run").StringValue
        }
        else{
            $run = $true
        }

        if ($debugMode) {
            Write-Host "Row - lineType = $linetype, run = $run, CodeunitId = $codeUnitId, codeunitName = '$codeunitName', name = '$name'"
        }

        if ($name) {
            if ($linetype -eq "0" -and !$ignoreGroups) {
                $group = @{ "Group" = $name; "Codeunits" = @() }
                $Tests += $group
                            
            } elseif ($linetype -eq "1") {
                $codeUnitName = $name
                if ($codeunitId -like $testCodeunit -or $codeunitName -like $testCodeunit) {
                    if ($debugMode) { 
                        Write-Host "Initialize Codeunit"
                    }
                    $codeunit = @{ "Id" = "$codeunitId"; "Name" = $codeUnitName; "Tests" = @() }
                    if ($group) {
                        $group.Codeunits += $codeunit
                    }
                    else {
                        if ($run) {
                            if ($debugMode) { 
                                Write-Host "Add codeunit to tests"
                            }
                            $Tests += $codeunit
                        }
                    }
                }
            } elseif ($lineType -eq "2") {
                if ($codeunitId -like $testCodeunit -or $codeunitName -like $testCodeunit) {
                    if ($run) {
                        if ($debugMode) { 
                            Write-Host "Add test $name"
                        }
                        $codeunit.Tests += $name
                    }
                }
            }
        }
    }
    $clientContext.CloseForm($form)
    $Tests | ConvertTo-Json
}

function Run-ConnectionTest {
    Param(
        [ClientContext] $clientContext,
        [switch] $debugMode,
        [switch] $connectFromHost
    )

#    $rolecenter = $clientContext.OpenForm(9020)
#    if (!($rolecenter)) {
#        throw "Cannot open rolecenter"
#    }
#    Write-Host "Rolecenter 9020 opened successfully"

    $extensionManagement = $clientContext.OpenForm(2500)
    if (!($extensionManagement)) {
        throw "Cannot open Extension Management page"
    }
    Write-Host "Extension Management opened successfully"

    $clientContext.CloseForm($extensionManagement)
    Write-Host "Extension Management successfully closed"
}

function GetDT {
    Param(
        $val
    )

    if ($val -is [DateTime]) {
        $val
    }
    else {
        [DateTime]::Parse($val)
    }
}

function Run-Tests {
    Param(
        [ClientContext] $clientContext,
        [int] $testPage = 130409,
        [string] $testSuite = "DEFAULT",
        [string] $testCodeunit = "*",
        [string] $testCodeunitRange = "",
        [string] $testGroup = "*",
        [string] $testFunction = "*",
        [string] $extensionId = "",
        [string] $requiredTestIsolation = "",
        [string] $testType = "",
        [string] $appName = "",
        [string] $testRunnerCodeunitId,
        [array]  $disabledtests = @(),
        [ValidateSet('Disabled', 'PerRun', 'PerCodeunit', 'PerTest')]
        [string] $CodeCoverageTrackingType = 'Disabled',
        [ValidateSet('Disabled','PerCodeunit','PerTest')]
        [string] $ProduceCodeCoverageMap = 'Disabled',
        [string] $CodeCoverageExporterId,
        [switch] $detailed,
        [switch] $debugMode,
        [string] $XUnitResultFileName = "",
        [switch] $AppendToXUnitResultFile,
        [string] $JUnitResultFileName = "",
        [switch] $AppendToJUnitResultFile,
        [switch] $ReRun,
        [ValidateSet('no','error','warning')]
        [string] $AzureDevOps = 'no',
        [ValidateSet('no','error','warning')]
        [string] $GitHubActions = 'no',
        [switch] $connectFromHost,
        [scriptblock] $renewClientContext
    )

    if ($testPage -eq 130455) {
        $LineTypeAdjust = 1
        $runSelectedName = "RunSelectedTests"
        $callStackName = "Stack Trace"
        $firstErrorName = "Error Message"
    }
    else {
        $lineTypeAdjust = 0
        $runSelectedName = "RunSelected"
        $callStackName = "Call Stack"
        $firstErrorName = "First Error"
        if ($disabledTests) {
            throw "Specifying disabledTests is not supported when using the C/AL test runner"
        }
        if ($extensionId) {
            throw "Specifying extensionId is not supported when using the C/AL test runner"
        }
        if ($testRunnerCodeunitId) {
            throw "Specifying testRunnerCodeunitId is not supported when using the C/AL test runner"
        }
    }
    $allPassed = $true
    $dumpAppsToTestOutput = $true

    if ($debugMode) {
        Write-Host "Run-Tests, open page $testpage"
    }

    $form = $clientContext.OpenForm($testPage)
    if (!($form)) {
        throw "Cannot open page $testPage. You might need to import the test toolkit to the container and/or remove the folder $PSScriptRoot and retry. You might also have URL or Company name wrong."
    }
    if ($extensionId -ne "" -and $testSuite -ne "DEFAULT") {
        throw "You cannot specify testSuite and extensionId at the same time"
    }

    $suiteControl = $clientContext.GetControlByName($form, "CurrentSuiteName")
    $clientContext.SaveValue($suiteControl, $testSuite)

    if ($testPage -eq 130455) {
        Set-ExtensionId -ExtensionId $extensionId -Form $form -ClientContext $clientContext -debugMode:$debugMode
        if (![string]::IsNullOrEmpty($requiredTestIsolation)) {
            Set-RequiredTestIsolation -RequiredTestIsolation $requiredTestIsolation -Form $form -ClientContext $clientContext -debugMode:$debugMode
        }
        if (![string]::IsNullOrEmpty($testType)) {
            Set-TestType -TestType $testType -Form $form -ClientContext $clientContext -debugMode:$debugMode
        }
        Set-TestCodeunitRange -testCodeunitRange $testCodeunitRange -Form $form -ClientContext $clientContext -debugMode:$debugMode
        Set-TestRunnerCodeunitId -TestRunnerCodeunitId $testRunnerCodeunitId -Form $form -ClientContext $clientContext -debugMode:$debugMode
        Set-RunFalseOnDisabledTests -DisabledTests $DisabledTests -Form $form -ClientContext $clientContext -debugMode:$debugMode
        $clientContext.InvokeAction($clientContext.GetActionByName($form, 'ClearTestResults'))
        if($CodeCoverageTrackingType -ne 'Disabled'){
            Set-CCTrackingType -Value $CodeCoverageTrackingType -Form $form -ClientContext $clientContext
            Set-CCExporterID -Value $CodeCoverageExporterId -Form $form -ClientContext $clientContext
            Clear-CCResults -Form $form -ClientContext $clientContext
            Set-CCProduceCodeCoverageMap -Value $ProduceCodeCoverageMap -Form $form -ClientContext $clientContext
        }
    }

    $process = $null
    if (!$connectFromHost) {
        $process = Get-Process -Name "Microsoft.Dynamics.Nav.Server" -ErrorAction SilentlyContinue
    }

    if ($XUnitResultFileName) {
        if (($Rerun -or $AppendToXUnitResultFile) -and (Test-Path $XUnitResultFileName)) {
            [xml]$XUnitDoc = [System.IO.File]::ReadAllLines($XUnitResultFileName)
            $XUnitAssemblies = $XUnitDoc.assemblies
            if (-not $XUnitAssemblies) {
                [xml]$XUnitDoc = New-Object System.Xml.XmlDocument
                $XUnitDoc.AppendChild($XUnitDoc.CreateXmlDeclaration("1.0","UTF-8",$null)) | Out-Null
                $XUnitAssemblies = $XUnitDoc.CreateElement("assemblies")
                $XUnitDoc.AppendChild($XUnitAssemblies) | Out-Null
            }
        }
        else {
            if (Test-Path $XUnitResultFileName -PathType Leaf) {
                Remove-Item $XUnitResultFileName -Force
            }
            [xml]$XUnitDoc = New-Object System.Xml.XmlDocument
            $XUnitDoc.AppendChild($XUnitDoc.CreateXmlDeclaration("1.0","UTF-8",$null)) | Out-Null
            $XUnitAssemblies = $XUnitDoc.CreateElement("assemblies")
            $XUnitDoc.AppendChild($XUnitAssemblies) | Out-Null
        }
    }
    if ($JUnitResultFileName) {
        if (($Rerun -or $AppendToJUnitResultFile) -and (Test-Path $JUnitResultFileName)) {
            [xml]$JUnitDoc = [System.IO.File]::ReadAllLines($JUnitResultFileName)

            $JUnitTestSuites = $JUnitDoc.testsuites
            if (-not $JUnitTestSuites) {
                [xml]$JUnitDoc = New-Object System.Xml.XmlDocument
                $JUnitDoc.AppendChild($JUnitDoc.CreateXmlDeclaration("1.0","UTF-8",$null)) | Out-Null
                $JUnitTestSuites = $JUnitDoc.CreateElement("testsuites")
                $JUnitDoc.AppendChild($JUnitTestSuites) | Out-Null
            }
        }
        else {
            if (Test-Path $JUnitResultFileName -PathType Leaf) {
                Remove-Item $JUnitResultFileName -Force
            }
            [xml]$JUnitDoc = New-Object System.Xml.XmlDocument
            $JUnitDoc.AppendChild($JUnitDoc.CreateXmlDeclaration("1.0","UTF-8",$null)) | Out-Null
            $JUnitTestSuites = $JUnitDoc.CreateElement("testsuites")
            $JUnitDoc.AppendChild($JUnitTestSuites) | Out-Null
        }
    }

    if ($testPage -eq 130455 -and $testCodeunit -eq "*" -and $testFunction -eq "*" -and $testGroup -eq "*" -and "$extensionId" -ne "") {

        if ($debugMode) {
            Write-Host "Using new test-runner mechanism"
        }

        $hostname = hostname

        while ($true) {
        
            if ($process) {
                $cimInstance = Get-CIMInstance Win32_OperatingSystem
                try { $cpu = "$($process.CPU.ToString("F3",[cultureinfo]::InvariantCulture))" } catch { $cpu = "n/a" }
                try { $mem = "$(($cimInstance.FreePhysicalMemory/1048576).ToString("F1",[CultureInfo]::InvariantCulture))" } catch { $mem = "n/a" }
                $processinfostart = "{ ""CPU"": ""$cpu"", ""Free Memory (Gb)"": ""$mem"" }"
            }
            $validationResults = $form.validationResults
            if ($validationResults) {
                throw "Validation errors occured. Error is: $($validationResults | ConvertTo-Json -Depth 99)"
            }
        
            if ($debugMode) {
                Write-Host "Invoke RunNextTest"
            }

            if ($renewClientContext) {
                $clientContext.CloseForm($form)
                $clientContext = Invoke-Command -ScriptBlock $renewClientContext
                $form = $clientContext.OpenForm($testPage)
            }

            $clientContext.InvokeAction($clientContext.GetActionByName($form, "RunNextTest"))
            $testResultControl = $clientContext.GetControlByName($form, "TestResultJson")
            $testResultJson = $testResultControl.StringValue

            if ($debugMode) {
                Write-Host "Result: '$testResultJson'"
            }

            if ($testResultJson -eq 'All tests executed.' -or $testResultJson -eq '') {
                break
            }
            $result = $testResultJson | ConvertFrom-Json
            $hasTestResults = [bool]($result.PSobject.Properties.name -eq "testResults")
        
            Write-Host -NoNewline "  Codeunit $($result.codeUnit) $($result.name) "

            $totalTests = 0
            if ($hasTestResults) {
                $totalTests = $result.testResults.Count
            }

            if ($XUnitResultFileName) {        
                if ($ReRun) {
                    $LastResult = $XUnitDoc.assemblies.ChildNodes | Where-Object { $_.name -eq "$($result.codeUnit) $($result.name)" }
                    if ($LastResult) {
                        $XUnitDoc.assemblies.RemoveChild($LastResult) | Out-Null
                    }
                }
                $XUnitAssembly = $XUnitDoc.CreateElement("assembly")
                $XUnitAssembly.SetAttribute("name","$($result.codeUnit) $($result.name)")
                $XUnitAssembly.SetAttribute("test-framework", "PS Test Runner")
                $XUnitAssembly.SetAttribute("run-date", (GetDT -val $result.startTime).ToString("yyyy-MM-dd"))
                $XUnitAssembly.SetAttribute("run-time", (GetDT -val $result.startTime).ToString("HH':'mm':'ss"))
                $XUnitAssembly.SetAttribute("total", $totalTests)
                $XUnitCollection = $XUnitDoc.CreateElement("collection")
                $XUnitAssembly.AppendChild($XUnitCollection) | Out-Null
                $XUnitCollection.SetAttribute("name", $result.name)
                $XUnitCollection.SetAttribute("total", $totalTests)
            }
            if ($JUnitResultFileName) {        
                if ($ReRun) {
                    $LastResult = $JUnitDoc.testsuites.ChildNodes | Where-Object { $_.name -eq "$($result.codeUnit) $($result.name)" }
                    if ($LastResult) {
                        $JUnitDoc.testsuites.RemoveChild($LastResult) | Out-Null
                    }
                }
                $JUnitTestSuite = $JUnitDoc.CreateElement("testsuite")
                $JUnitTestSuite.SetAttribute("name","$($result.codeUnit) $($result.name)")
                $JUnitTestSuite.SetAttribute("timestamp", (Get-Date -Format s))
                $JUnitTestSuite.SetAttribute("hostname", $hostname)

                $JUnitTestSuite.SetAttribute("time", 0)
                $JUnitTestSuite.SetAttribute("tests", $totalTests)

                $JunitTestSuiteProperties = $JUnitDoc.CreateElement("properties")
                $JUnitTestSuite.AppendChild($JunitTestSuiteProperties) | Out-Null

                if ($extensionid) {
                    $property = $JUnitDoc.CreateElement("property")
                    $property.SetAttribute("name","extensionid")
                    $property.SetAttribute("value", $extensionId)
                    $JunitTestSuiteProperties.AppendChild($property) | Out-Null

                    if (-not $appName -and $process) {
                        $appName = "$(Get-NavAppInfo -ServerInstance $serverInstance | Where-Object { "$($_.AppId)" -eq $extensionId } | ForEach-Object { $_.Name })"
                    }
                    if ($appName) {
                        $property = $JUnitDoc.CreateElement("property")
                        $property.SetAttribute("name","appName")
                        $property.SetAttribute("value", $appName)
                        $JunitTestSuiteProperties.AppendChild($property) | Out-Null
                    }
                }

                if ($process) {
                    $property = $JUnitDoc.CreateElement("property")
                    $property.SetAttribute("name","processinfo.start")
                    $property.SetAttribute("value", $processinfostart)
                    $JunitTestSuiteProperties.AppendChild($property) | Out-Null

                    if ($dumpAppsToTestOutput) {
                        $versionInfo = (Get-Item -Path "C:\Program Files\Microsoft Dynamics NAV\*\Service\Microsoft.Dynamics.Nav.Server.exe").VersionInfo
                        $property = $JUnitDoc.CreateElement("property")
                        $property.SetAttribute("name", "platform.info")
                        $property.SetAttribute("value", "{ ""Version"": ""$($VersionInfo.ProductVersion)"" }")
                        $JunitTestSuiteProperties.AppendChild($property) | Out-Null
    
                        Get-NavAppInfo -ServerInstance $serverInstance | ForEach-Object {
                            $property = $JUnitDoc.CreateElement("property")
                            $property.SetAttribute("name", "app.info")
                            $property.SetAttribute("value", "{ ""Name"": ""$($_.Name)"", ""Publisher"": ""$($_.Publisher)"", ""Version"": ""$($_.Version)"" }")
                            $JunitTestSuiteProperties.AppendChild($property) | Out-Null
                        }
                        $dumpAppsToTestOutput = $false
                    }
                }
            }
        
            $totalduration = [Timespan]::Zero
            if ($hasTestResults) {
                $result.testResults | ForEach-Object {
                    $testduration = (GetDT -val $_.finishTime).Subtract((GetDT -val $_.startTime))
                    if ($testduration.TotalSeconds -lt 0) { $testduration = [timespan]::Zero }
                    $totalduration += $testduration
                }
            }
        
            if ($result.result -eq "2") {
                Write-Host -ForegroundColor Green "Success ($([Math]::Round($totalduration.TotalSeconds,3)) seconds)"
            }
            elseif ($result.result -eq "1") {
                Write-Host -ForegroundColor Red "Failure ($([Math]::Round($totalduration.TotalSeconds,3)) seconds)"
                $allPassed = $false
            }
            else {
                Write-Host -ForegroundColor Yellow "Skipped"
            }
        
            $passed = 0
            $failed = 0
            $skipped = 0
        
            if ($hasTestResults) {
                $result.testResults | ForEach-Object {
                    $testduration = (GetDT -val $_.finishTime).Subtract((GetDT -val $_.startTime))
                    if ($testduration.TotalSeconds -lt 0) { $testduration = [timespan]::Zero }
        
                    if ($XUnitResultFileName) {
                        if ($XUnitAssembly.ParentNode -eq $null) {
                            $XUnitAssemblies.AppendChild($XUnitAssembly) | Out-Null
                        }
            
                        $XUnitTest = $XUnitDoc.CreateElement("test")
                        $XUnitCollection.AppendChild($XUnitTest) | Out-Null
                        $XUnitTest.SetAttribute("name", $XUnitCollection.GetAttribute("name")+':'+$_.method)
                        $XUnitTest.SetAttribute("method", $_.method)
                        $XUnitTest.SetAttribute("time", [Math]::Round($testduration.TotalSeconds,3).ToString([System.Globalization.CultureInfo]::InvariantCulture))
                    }
                    if ($JUnitResultFileName) {
                        if ($JUnitTestSuite.ParentNode -eq $null) {
                            $JUnitTestSuites.AppendChild($JUnitTestSuite) | Out-Null
                        }
            
                        $JUnitTestCase = $JUnitDoc.CreateElement("testcase")
                        $JUnitTestSuite.AppendChild($JUnitTestCase) | Out-Null
                        $JUnitTestCase.SetAttribute("classname", $JUnitTestSuite.GetAttribute("name"))
                        $JUnitTestCase.SetAttribute("name", $_.method)
                        $JUnitTestCase.SetAttribute("time", [Math]::Round($testduration.TotalSeconds,3).ToString([System.Globalization.CultureInfo]::InvariantCulture))
                    }
                    if ($_.result -eq 2) {
                        if ($detailed) {
                            Write-Host -ForegroundColor Green "    Testfunction $($_.method) Success ($([Math]::Round($testduration.TotalSeconds,3)) seconds)"
                        }
                        if ($XUnitResultFileName) {
                            $XUnitTest.SetAttribute("result", "Pass")
                        }
                        $passed++
                    }
                    elseif ($_.result -eq 1) {
                        $stacktrace = $_.stacktrace
                        if ($stacktrace.EndsWith(';')) {
                            $stacktrace = $stacktrace.Substring(0,$stacktrace.Length-1)
                        }
                        if ($AzureDevOps -ne 'no') {
                            Write-Host "##vso[task.logissue type=$AzureDevOps;sourcepath=$($_.method);]$($_.message)"
                        }
                        if ($GitHubActions -ne 'no') {
                            Write-Host "::$($GitHubActions)::Function $($_.method) $($_.message)"
                        }
                        Write-Host -ForegroundColor Red "    Testfunction $($_.method) Failure ($([Math]::Round($testduration.TotalSeconds,3)) seconds)"
                        if ($XUnitResultFileName) {
                            $XUnitTest.SetAttribute("result", "Fail")
                        }
                        $failed++
            
                        if ($detailed) {
                            Write-Host -ForegroundColor Red "      Error:"
                            Write-Host -ForegroundColor Red "        $($_.message)"
                            Write-Host -ForegroundColor Red "      Call Stack:"
                            Write-Host -ForegroundColor Red "        $($stacktrace.Replace(";","`n        "))"
                        }
            
                        if ($XUnitResultFileName) {
                            $XUnitFailure = $XUnitDoc.CreateElement("failure")
                            $XUnitMessage = $XUnitDoc.CreateElement("message")
                            $XUnitMessage.InnerText = $_.message
                            $XUnitFailure.AppendChild($XUnitMessage) | Out-Null
                            $XUnitStacktrace = $XUnitDoc.CreateElement("stack-trace")
                            $XUnitStacktrace.InnerText = $_.stacktrace.Replace(";","`n")
                            $XUnitFailure.AppendChild($XUnitStacktrace) | Out-Null
                            $XUnitTest.AppendChild($XUnitFailure) | Out-Null
                        }
                        if ($JUnitResultFileName) {
                            $JUnitFailure = $JUnitDoc.CreateElement("failure")
                            $JUnitFailure.SetAttribute("message", $_.message)
                            $JUnitFailure.InnerText = $_.stacktrace.Replace(";","`n")
                            $JUnitTestCase.AppendChild($JUnitFailure) | Out-Null
                        }
                    }
                    else {
                        if ($detailed) {
                            Write-Host -ForegroundColor Yellow "    Testfunction $($_.method) Skipped"
                        }
            
                        if ($XUnitResultFileName) {
                            $XUnitTest.SetAttribute("result", "Skip")
                        }
                        if ($JUnitResultFileName) {
                            $JUnitSkipped = $JUnitDoc.CreateElement("skipped")
                            $JUnitTestCase.AppendChild($JUnitSkipped) | Out-Null
                        }
                        $skipped++
                    }
                }
            }
        
            if ($XUnitResultFileName) {
                $XUnitAssembly.SetAttribute("passed", $Passed)
                $XUnitAssembly.SetAttribute("failed", $failed)
                $XUnitAssembly.SetAttribute("skipped", $skipped)
                $XUnitAssembly.SetAttribute("time", [Math]::Round($totalduration.TotalSeconds,3).ToString([System.Globalization.CultureInfo]::InvariantCulture))
        
                $XUnitCollection.SetAttribute("passed", $Passed)
                $XUnitCollection.SetAttribute("failed", $failed)
                $XUnitCollection.SetAttribute("skipped", $skipped)
                $XUnitCollection.SetAttribute("time", [Math]::Round($totalduration.TotalSeconds,3).ToString([System.Globalization.CultureInfo]::InvariantCulture))
            }
            if ($JUnitResultFileName) {
                $JUnitTestSuite.SetAttribute("errors", 0)
                $JUnitTestSuite.SetAttribute("failures", $failed)
                $JUnitTestSuite.SetAttribute("skipped", $skipped)
                $JUnitTestSuite.SetAttribute("time", [Math]::Round($totalduration.TotalSeconds,3).ToString([System.Globalization.CultureInfo]::InvariantCulture))
                if ($process) {
                    $cimInstance = Get-CIMInstance Win32_OperatingSystem
                    $property = $JUnitDoc.CreateElement("property")
                    $property.SetAttribute("name","processinfo.end")
                    try { $cpu = "$($process.CPU.ToString("F3",[CultureInfo]::InvariantCulture))" } catch { $cpu = "n/a" }
                    try { $mem = "$(($cimInstance.FreePhysicalMemory/1048576).ToString("F1",[CultureInfo]::InvariantCulture))" } catch { $mem = "n/a" }
                    $property.SetAttribute("value", "{ ""CPU"": ""$cpu"", ""Free Memory (Gb)"": ""$mem"" }")
                    $JunitTestSuiteProperties.AppendChild($property) | Out-Null
                }
            }
        }

    }
    else {

        if ($debugMode -and $testpage -eq 130455) {
            Write-Host "Using repeater based test-runner"
        }

        $hostname = hostname

        $filterControl = $clientContext.GetControlByType($form, [Microsoft.Dynamics.Framework.UI.Client.ClientFilterLogicalControl])
        $repeater = $clientContext.GetControlByType($form, [Microsoft.Dynamics.Framework.UI.Client.ClientRepeaterControl])
        $index = 0
        if ($testPage -eq 130455) {
            if ($debugMode) {
                Write-Host "Offset: $($repeater.offset)"
            }
            $clientContext.SelectFirstRow($repeater)
            $clientContext.Refresh($repeater)
            if ($debugMode) {
                Write-Host "Offset: $($repeater.offset)"
            }
        }

        $i = 0
        if ([int]::TryParse($testCodeunit, [ref] $i) -and ($testCodeunit -eq $i)) {
            if (([System.Management.Automation.PSTypeName]'Microsoft.Dynamics.Framework.UI.Client.Interactions.ExecuteFilterInteraction').Type) {
                $filterInteraction = New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.ExecuteFilterInteraction -ArgumentList $filterControl
                $filterInteraction.QuickFilterColumnId = $filterControl.QuickFilterColumns[0].Id
                $filterInteraction.QuickFilterValue = $testCodeunit
                $clientContext.InvokeInteraction($filterInteraction)
            }
            else {
                $filterInteraction = New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.FilterInteraction -ArgumentList $filterControl
                $filterInteraction.FilterColumnId = $filterControl.FilterColumns[0].Id
                $filterInteraction.FilterValue = $testCodeunit
                $clientContext.InvokeInteraction($filterInteraction)
                if ($testPage -eq 130455) {
                    $clientContext.SelectFirstRow($repeater)
                    $clientContext.Refresh($repeater)
                }
            }
        }
    
        $codeunitName = ""
        $codeunitNames = @{}
        $LastCodeunitName = ""
        $groupName = ""
    
        while ($true)
        {
    
            $validationResults = $form.validationResults
            if ($validationResults) {
                throw "Validation errors occured. Error is: $($validationResults | ConvertTo-Json -Depth 99)"
            }
    
            do {
    
                if ($debugMode) {
                    Write-Host "Index:  $index, Offset: $($repeater.Offset), Count:  $($repeater.DefaultViewport.Count)"
                }        
    
                if ($index -ge ($repeater.Offset + $repeater.DefaultViewport.Count))
                {
                    if ($debugMode) {
                        Write-Host "Scroll"
                    }
                    $clientContext.ScrollRepeater($repeater, 1)
                    if ($debugMode) {
                        Write-Host "Index:  $index, Offset: $($repeater.Offset), Count:  $($repeater.DefaultViewport.Count)"
                    }        
                }
                $rowIndex = $index - $repeater.Offset
                $index++
                if ($rowIndex -ge $repeater.DefaultViewport.Count)
                {
                    if ($debugMode) {
                        Write-Host "Breaking - rowIndex: $rowIndex"
                    }
                    break
                }
                $row = $repeater.DefaultViewport[$rowIndex]
                $lineTypeControl = $clientContext.GetControlByName($row, "LineType")
                $lineType = "$(([int]$lineTypeControl.StringValue) + $lineTypeAdjust)"
                $name = $clientContext.GetControlByName($row, "Name").StringValue
                $codeUnitId = $clientContext.GetControlByName($row, "TestCodeunit").StringValue
                if ($testPage -eq 130455) {
                    $run = $clientContext.GetControlByName($row, "Run").StringValue
                }
                else{
                    $run = $true
                }

                if ($debugMode) {
                    Write-Host "Row - lineType = $linetype, run = $run, CodeunitId = $codeUnitId, codeunitName = '$codeunitName', name = '$name'"
                }
    
                if ($name) {
                    if ($linetype -eq "0") {
                        $groupName = $name
                    }
                    elseif ($linetype -eq "1") {
                        $codeUnitName = $name
                        if (!($codeUnitNames.Contains($codeunitId))) {
                            $codeUnitNames += @{ $codeunitId = $codeunitName }
                        }
                    }
                    elseif ($linetype -eq "2") {
                        $codeUnitname = $codeUnitNames[$codeunitId]
                    }
                }
            } while (!(($codeunitId -like $testCodeunit -or $codeunitName -like $testCodeunit) -and ($linetype -eq "1" -or $name -like $testFunction)))
    
            if ($debugMode) {
                Write-Host "Found Row - index = $index, rowIndex = $($rowIndex)/$($repeater.DefaultViewport.Count), lineType = $linetype, run = $run, CodeunitId = $codeUnitId, codeunitName = '$codeunitName', name = '$name'"
            }
    
            if ($rowIndex -ge $repeater.DefaultViewport.Count -or !($name))
            {
                break 
            }
    
            if ($groupName -like $testGroup) {
                switch ($linetype) {
                    "1" {
                        $startTime = get-date
                        $totalduration = [Timespan]::Zero

                        if ($TestFunction -eq "*") {
                            Write-Host "  Codeunit $codeunitId $name " -NoNewline

                            $prevoffset = $repeater.Offset

                            if ($testPage -eq 130455 -and $testCodeunit -eq "*") {
                                $filterInteraction = New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.FilterInteraction -ArgumentList $filterControl
                                $filterInteraction.FilterColumnId = $filterControl.FilterColumns[0].Id
                                $filterInteraction.FilterValue = $codeUnitId
                                $clientContext.InvokeInteraction($filterInteraction)
                                $clientContext.SelectFirstRow($repeater)
                                $clientContext.Refresh($repeater)
                            }
                            else {
                                $clientContext.ActivateControl($lineTypeControl)
                            }

                            $clientContext.InvokeAction($clientContext.GetActionByName($form, $runSelectedName))
            
                            if ($testPage -eq 130455) {
                                if ($testCodeunit -eq "*") {
                                    $filterInteraction = New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.FilterInteraction -ArgumentList $filterControl
                                    $filterInteraction.FilterColumnId = $filterControl.FilterColumns[0].Id
                                    $filterInteraction.FilterValue = ''
                                    $clientContext.InvokeInteraction($filterInteraction)
                                }
                                $clientContext.SelectFirstRow($repeater)
                                $clientContext.Refresh($repeater)
                            
                                while ($repeater.Offset -lt $prevoffset) {
                                    $clientContext.ScrollRepeater($repeater, 1)
                                }
                                $row = $repeater.DefaultViewport[$rowIndex]
                            }
                            else {
                                $row = $repeater.CurrentRow
                                if ($repeater.DefaultViewport[0].Bookmark -eq $row.Bookmark) {
                                    $index = $repeater.Offset+1
                                }
                            }

                            $finishTime = get-date
                            $duration = $finishTime.Subtract($startTime)
    
                            $result = $clientContext.GetControlByName($row, "Result").StringValue
                            if ($result -eq "2") {
                                Write-Host -ForegroundColor Green "Success ($([Math]::Round($duration.TotalSeconds,3)) seconds)"
                            }
                            elseif ($result -eq "3") {
                                Write-Host -ForegroundColor Yellow "Skipped"
                            }
                            else {
                                Write-Host -ForegroundColor Red "Failure ($([Math]::Round($duration.TotalSeconds,3)) seconds)"
                                $allPassed = $false
                            }
                        }
                        if ($XUnitResultFileName) {
                            if ($ReRun) {
                                $LastResult = $XUnitDoc.assemblies.ChildNodes | Where-Object { $_.name -eq "$codeunitId $Name" }
                                if ($LastResult) {
                                    $XUnitDoc.assemblies.RemoveChild($LastResult) | Out-Null
                                }
                            }
                            $XUnitAssembly = $XUnitDoc.CreateElement("assembly")
                            $XUnitAssembly.SetAttribute("name","$codeunitId $Name")
                            $XUnitAssembly.SetAttribute("test-framework", "PS Test Runner")
                            $XUnitAssembly.SetAttribute("run-date", $startTime.ToString("yyyy-MM-dd"))
                            $XUnitAssembly.SetAttribute("run-time", $startTime.ToString("HH':'mm':'ss"))
                            $XUnitAssembly.SetAttribute("total",0)
                            $XUnitAssembly.SetAttribute("passed",0)
                            $XUnitAssembly.SetAttribute("failed",0)
                            $XUnitAssembly.SetAttribute("skipped",0)
                            $XUnitAssembly.SetAttribute("time", "0")
                            $XUnitCollection = $XUnitDoc.CreateElement("collection")
                            $XUnitAssembly.AppendChild($XUnitCollection) | Out-Null
                            $XUnitCollection.SetAttribute("name","$Name")
                            $XUnitCollection.SetAttribute("total",0)
                            $XUnitCollection.SetAttribute("passed",0)
                            $XUnitCollection.SetAttribute("failed",0)
                            $XUnitCollection.SetAttribute("skipped",0)
                            $XUnitCollection.SetAttribute("time", "0")
                        }
                        if ($JUnitResultFileName) {
                            if ($ReRun) {
                                $LastResult = $JUnitDoc.testsuites.ChildNodes | Where-Object { $_.name -eq "$codeunitId $Name" }
                                if ($LastResult) {
                                    $JUnitDoc.testsuites.RemoveChild($LastResult) | Out-Null
                                }
                            }
                            $JUnitTestSuite = $JUnitDoc.CreateElement("testsuite")
                            $JUnitTestSuite.SetAttribute("name","$codeunitId $Name")
                            $JUnitTestSuite.SetAttribute("timestamp", (Get-Date -Format s))
                            $JUnitTestSuite.SetAttribute("hostname", $hostname)
                            $JUnitTestSuite.SetAttribute("time", 0)
                            $JUnitTestSuite.SetAttribute("tests", 0)
                            $JUnitTestSuite.SetAttribute("failures", 0)
                            $JUnitTestSuite.SetAttribute("errors", 0)
                            $JUnitTestSuite.SetAttribute("skipped", 0)
                        }
                    }
                    "2" {
                        if ($testFunction -ne "*") {
                            if ($LastCodeunitName -ne $codeunitName) {
                                Write-Host "Codeunit $CodeunitId $CodeunitName"
                                $LastCodeunitName = $CodeUnitname
                            }
                            $clientContext.ActivateControl($lineTypeControl)

                            $startTime = get-date
                            $clientContext.InvokeAction($clientContext.GetActionByName($form, $runSelectedName))
                            $finishTime = get-date
                            $testduration = $finishTime.Subtract($startTime)
                            if ($testduration.TotalSeconds -lt 0) { $testduration = [timespan]::Zero }

                            $row = $repeater.CurrentRow
                            for ($idx = 0; $idx -lt $repeater.DefaultViewPort.Count; $idx++) {
                                if ($repeater.DefaultViewPort[$idx].Bookmark -eq $row.Bookmark) {
                                    $index = $repeater.Offset+$idx+1
                                }
                            }
                        }
                        $result = $clientContext.GetControlByName($row, "Result").StringValue
                        $startTime = $clientContext.GetControlByName($row, "Start Time").ObjectValue
                        $finishTime = $clientContext.GetControlByName($row, "Finish Time").ObjectValue
                        $testduration = $finishTime.Subtract($startTime)
                        if ($testduration.TotalSeconds -lt 0) { $testduration = [timespan]::Zero }
                        $totalduration += $testduration
                        if ($XUnitResultFileName) {
                            if ($XUnitAssembly.ParentNode -eq $null) {
                                $XUnitAssemblies.AppendChild($XUnitAssembly) | Out-Null
                            }
                            $XUnitAssembly.SetAttribute("time",([Math]::Round($totalduration.TotalSeconds,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture))
                            $XUnitAssembly.SetAttribute("total",([int]$XUnitAssembly.GetAttribute("total")+1))
                            $XUnitTest = $XUnitDoc.CreateElement("test")
                            $XUnitCollection.AppendChild($XUnitTest) | Out-Null
                            $XUnitTest.SetAttribute("name", $XUnitCollection.GetAttribute("name")+':'+$Name)
                            $XUnitTest.SetAttribute("method", $Name)
                            $XUnitTest.SetAttribute("time", ([Math]::Round($testduration.TotalSeconds,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture))
                        }
                        if ($JUnitResultFileName) {
                            if ($JUnitTestSuite.ParentNode -eq $null) {
                                $JUnitTestSuites.AppendChild($JUnitTestSuite) | Out-Null
                            }
                            $JUnitTestSuite.SetAttribute("time",([Math]::Round($totalduration.TotalSeconds,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture))
                            $JUnitTestSuite.SetAttribute("total",([int]$JUnitTestSuite.GetAttribute("total")+1))
                            $JUnitTestCase = $JUnitDoc.CreateElement("testcase")
                            $JUnitTestSuite.AppendChild($JUnitTestCase) | Out-Null
                            $JUnitTestCase.SetAttribute("classname", $JUnitTestSuite.GetAttribute("name"))
                            $JUnitTestCase.SetAttribute("name", $Name)
                            $JUnitTestCase.SetAttribute("time", ([Math]::Round($testduration.TotalSeconds,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture))
                        }
                        if ($result -eq "2") {
                            if ($detailed) {
                                Write-Host -ForegroundColor Green "    Testfunction $name Success ($([Math]::Round($testduration.TotalSeconds,3)) seconds)"
                            }
                            if ($XUnitResultFileName) {
                                $XUnitAssembly.SetAttribute("passed",([int]$XUnitAssembly.GetAttribute("passed")+1))
                                $XUnitTest.SetAttribute("result", "Pass")
                            }
                        }
                        elseif ($result -eq "1") {
                            $firstError = $clientContext.GetControlByName($row, $firstErrorName).StringValue
                            $callStack = $clientContext.GetControlByName($row, $callStackName).StringValue
                            if ($callStack.EndsWith("\")) { $callStack = $callStack.Substring(0,$callStack.Length-1) }
                            if ($AzureDevOps -ne 'no') {
                                Write-Host "##vso[task.logissue type=$AzureDevOps;sourcepath=$name;]$firstError"
                            }
                            if ($GitHubActions -ne 'no') {
                                Write-Host "::$($GitHubActions)::Function $name $firstError"
                            }
                            Write-Host -ForegroundColor Red "    Testfunction $name Failure ($([Math]::Round($testduration.TotalSeconds,3)) seconds)"
                            $allPassed = $false
                            if ($XUnitResultFileName) {
                                $XUnitAssembly.SetAttribute("failed",([int]$XUnitAssembly.GetAttribute("failed")+1))
                                $XUnitTest.SetAttribute("result", "Fail")
                                $XUnitFailure = $XUnitDoc.CreateElement("failure")
                                $XUnitMessage = $XUnitDoc.CreateElement("message")
                                $XUnitMessage.InnerText = $firstError
                                $XUnitFailure.AppendChild($XUnitMessage) | Out-Null
                                $XUnitStacktrace = $XUnitDoc.CreateElement("stack-trace")
                                $XUnitStacktrace.InnerText = $Callstack.Replace("\","`n")
                                $XUnitFailure.AppendChild($XUnitStacktrace) | Out-Null
                                $XUnitTest.AppendChild($XUnitFailure) | Out-Null
                            }
                            if ($JUnitResultFileName) {
                                $JUnitTestSuite.SetAttribute("failures",([int]$JUnitTestSuite.GetAttribute("failures")+1))
                                $JUnitTestCase.SetAttribute("result", "Fail")
                                $JUnitFailure = $JUnitDoc.CreateElement("failure")
                                $JUnitFailure.SetAttribute("message", $firstError)
                                $JUnitFailure.InnerText = $Callstack.Replace("\","`n")
                                $JUnitTestCase.AppendChild($JUnitFailure) | Out-Null
                            }
                        }
                        else {
                            if ($detailed) {
                                Write-Host -ForegroundColor Yellow "    Testfunction $name Skipped"
                            }
                            if ($XUnitResultFileName) {
                                $XUnitCollection.SetAttribute("skipped",([int]$XUnitCollection.GetAttribute("skipped")+1))
                                $XUnitAssembly.SetAttribute("skipped",([int]$XUnitAssembly.GetAttribute("skipped")+1))
                                $XUnitTest.SetAttribute("result", "Skip")
                            }
                            if ($JUnitResultFileName) {
                                $JUnitTestSuite.SetAttribute("skipped",([int]$JUnitTestSuite.GetAttribute("skipped")+1))
                                $JUnitSkipped = $JUnitDoc.CreateElement("skipped")
                                $JUnitTestCase.AppendChild($JUnitSkipped) | Out-Null
                            }
                        }
                        if ($result -eq "1" -and $detailed) {
                            Write-Host -ForegroundColor Red "      Error:"
                            Write-Host -ForegroundColor Red "        $firstError"
                            Write-Host -ForegroundColor Red "      Call Stack:"
                            Write-Host -ForegroundColor Red "        $($callStack.Replace('\',"`n        "))"
                        }
                        if ($XUnitResultFileName) {
                            $XUnitCollection.SetAttribute("time", $XUnitAssembly.GetAttribute("time"))
                            $XUnitCollection.SetAttribute("total", $XUnitAssembly.GetAttribute("total"))
                            $XUnitCollection.SetAttribute("passed", $XUnitAssembly.GetAttribute("passed"))
                            $XUnitCollection.SetAttribute("failed", $XUnitAssembly.GetAttribute("failed"))
                            $XUnitCollection.SetAttribute("Skipped", $XUnitAssembly.GetAttribute("skipped"))
                        }
                    }
                    else {
                    }
                }
            }
        }
    }
    if ($XUnitResultFileName) {
        $XUnitDoc.Save($XUnitResultFileName)
    }
    if ($JUnitResultFileName) {
        $JUnitDoc.Save($JUnitResultFileName)
    }
    $clientContext.CloseForm($form)
    $allPassed
}

function Disable-SslVerification
{
    if (-not ([System.Management.Automation.PSTypeName]"SslVerification").Type)
    {
$sslCallbackCode = @"
    #pragma warning disable
    using System.Net.Security;
    using System.Security.Cryptography.X509Certificates;

    public static class SslVerification
    {
        public static bool DisabledServerCertificateValidationCallback(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors sslPolicyErrors) { return true; }
        public static void Disable() { System.Net.ServicePointManager.ServerCertificateValidationCallback = DisabledServerCertificateValidationCallback; }
        public static void Enable()  { System.Net.ServicePointManager.ServerCertificateValidationCallback = null; }
    }
    #pragma warning restore
"@
        Add-Type -TypeDefinition $sslCallbackCode
    }
    [SslVerification]::Disable()
}

function Enable-SslVerification
{
    if (([System.Management.Automation.PSTypeName]"SslVerification").Type)
    {
        [SslVerification]::Enable()
    }
}

function Set-TcpKeepAlive {
    Param(
        [Duration] $tcpKeepAlive
    )

    # Set Keep-Alive on Tcp Level to 1 minute to avoid Azure closing our connection
    [System.Net.ServicePointManager]::SetTcpKeepAlive($true, [int]$tcpKeepAlive.TotalMilliseconds, [int]$tcpKeepAlive.TotalMilliseconds)
}

# SIG # Begin signature block
# MIInSQYJKoZIhvcNAQcCoIInOjCCJzYCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCAloVh3HYo+dMys
# TfMPZMoih/LlA/SdwL+/RC/65l4wLqCCDLowggX1MIID3aADAgECAhMzAAACHU0Z
# yE7XD1dIAAAAAAIdMA0GCSqGSIb3DQEBCwUAMFcxCzAJBgNVBAYTAlVTMR4wHAYD
# VQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xKDAmBgNVBAMTH01pY3Jvc29mdCBD
# b2RlIFNpZ25pbmcgUENBIDIwMjQwHhcNMjYwNDE2MTg1OTQzWhcNMjcwNDE1MTg1
# OTQzWjB0MQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UE
# BxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMR4wHAYD
# VQQDExVNaWNyb3NvZnQgQ29ycG9yYXRpb24wggEiMA0GCSqGSIb3DQEBAQUAA4IB
# DwAwggEKAoIBAQDQvewXxx9gZZFC6Ys1WBay8BJ8kGA4JQnH5CMafqOASlTpK9H8
# o5ZXTXt0caVQTNMUPt445wXYD+dFtaKWTwDn1I52oUSrC9vJin1Gsqt+zyKJL5Dg
# 3eQXbQNR61DmMy20GLTIO3SFed9Rfi/ophgCLGFLDR3r0KvHjwMb/jYWS0celV/4
# Lz27LfAekm8v9E5IXaeiXbAUYZKK090n4CVl3JBtbN+9DtI9SNu/yjvozW52/u7R
# X/Ttpa/KDlpuokZ+Zcbvmtd9ur9gFLvZzh41o9MsE/clQtdaFWGvuo6Jua/ntpgk
# ey3E5/vBFe+MJPG6phdnuo6r57ZudCudiI1bAgMBAAGjggGbMIIBlzAOBgNVHQ8B
# Af8EBAMCB4AwHwYDVR0lBBgwFgYKKwYBBAGCN0wIAQYIKwYBBQUHAwMwHQYDVR0O
# BBYEFH6QuMwqcPG0hQlQ6c5jCtTTLrVeMEUGA1UdEQQ+MDykOjA4MR4wHAYDVQQL
# ExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xFjAUBgNVBAUTDTIzMDAxMis1MDc1NTkw
# HwYDVR0jBBgwFoAUf1k/VCHarU/vBeXmo9ctBpQSCDEwYAYDVR0fBFkwVzBVoFOg
# UYZPaHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3BraW9wcy9jcmwvTWljcm9zb2Z0
# JTIwQ29kZSUyMFNpZ25pbmclMjBQQ0ElMjAyMDI0LmNybDBtBggrBgEFBQcBAQRh
# MF8wXQYIKwYBBQUHMAKGUWh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMv
# Y2VydHMvTWljcm9zb2Z0JTIwQ29kZSUyMFNpZ25pbmclMjBQQ0ElMjAyMDI0LmNy
# dDAMBgNVHRMBAf8EAjAAMA0GCSqGSIb3DQEBCwUAA4ICAQBKTbYOjzwTG/DXGaz9
# s6+fQeaTtDcFmMY+5UyVFCyj7Pv+5i37qfX8lSL/tBIfYQfWsMuBQlfZurJD6r4H
# VJ2CeH+1fgiq8dcHdVKoZ3Sa2qXoX3cq9iS8cVb06B7+5/XJ7I0OxHH9fDsvJ3T3
# w5V/ZtAIFmLrl+P0CtG+92uzRsn0nTbdFjOkLMLWPLAU3THohKRlSEMgFJpPkm5n
# 5UAZ35xX6FWCrDLsSKb555bTifwa8mJBwdlof0bmfYidH+dxZ1FdDxvLnNl9zeKs
# A4kejaaIqqIPguhwAti5Ql7BlTNoJNwxCvBmqW2MQLnCkYN/VVUsR3V2x/rcTNzo
# Bf/Z/SpROvdaA2ZOOd1uioXJt3tdLQ7vHpqpib0KfWr/FWXW10q38VxfCnRQBqzb
# SuztR7nEMuzX7Ck+B/XaPDXd1qh72+QYyB0Z2VzWmO9zsnb9Uq/dwu8LGeQqnyu6
# 7SDGACvnXii2fb9+US492VTnXSnFKyqwgzUyFMtZK1/sHYTv6bG4TtQUygQxTN+Z
# V+aJIlKO2MqZ7bKrAnOzS9m6NgoTdWOq11bTOZwKlIEV/EhV9SWkDmdpR/hPPT2v
# 6TEj4F8PT/zHjRezIU5c/DGlt/VhY/pK0XkJtEyMmmS1BMtjU/rqBZVMIm3dnxQs
# /TBByr+Cf8Z1r7aifQVQ+WSqzjCCBr0wggSloAMCAQICEzMAAAA5O7Y3Gb8GHWcA
# AAAAADkwDQYJKoZIhvcNAQEMBQAwgYgxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpX
# YXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25kMR4wHAYDVQQKExVNaWNyb3NvZnQg
# Q29ycG9yYXRpb24xMjAwBgNVBAMTKU1pY3Jvc29mdCBSb290IENlcnRpZmljYXRl
# IEF1dGhvcml0eSAyMDExMB4XDTI0MDgwODIwNTQxOFoXDTM2MDMyMjIyMTMwNFow
# VzELMAkGA1UEBhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEo
# MCYGA1UEAxMfTWljcm9zb2Z0IENvZGUgU2lnbmluZyBQQ0EgMjAyNDCCAiIwDQYJ
# KoZIhvcNAQEBBQADggIPADCCAgoCggIBANgBnB7jOMeqlRYHNa265v4IY9fH8TKh
# emHfPINe1gpLaV3dhg324WwH06LcHbpnsBukCDNitryo0dtS/EW6I/yEL/bLSY8h
# KpbfQuWusBPr9qazYcDxCW/qnjb5JsI1s8bNOg3bVATvQVL4tcf03aTycsz8QeCd
# M0l/yHRObJ9QqazM1r6VPEOJ7LL+uEEb73w6QCuhs89a1uv1zerOYMnsneRRwCbp
# yW11IcggU0cRKDDq1pjVJzIbIF6+oiXXbReOsgeI8zu1FyQfK0fVkaya8SmVHQ/t
# Of23mZ4W9k0Ri22QW9p3UgSC5OUDktKxxcCmGL6tXLfOGSWHIIV4YrTJTT6PNty5
# REojHJuZHArkF9VnHTERWoTjAzfI3kP+5b4alUdhgAZ7ttOu1bVnXfHaqPYl2rPs
# 20ji03LOVWsh/radgE17es5hL+t6lV0eVHrVhsssROWJuz2MXMCt7iw7lFPG9LXK
# Gjsmonn2gotGdHIuEg5JnJMJVmixd5LRlkmgYRZKzhxSCwyoGIq0PhaA7Y+VPct5
# pCHkijcIIDm0nlkK+0KyepolcqGm0T/GYQRMhHJlGOOmVQop36wUVUYklUy++vDW
# eEgEo4s7hxN6mIbf2MSIQ/iIfMZgJxC69oukMUXCrOC3SkE/xIkgpfl22MM1itkZ
# 35nNXkMolU1lAgMBAAGjggFOMIIBSjAOBgNVHQ8BAf8EBAMCAYYwEAYJKwYBBAGC
# NxUBBAMCAQAwHQYDVR0OBBYEFH9ZP1Qh2q1P7wXl5qPXLQaUEggxMBkGCSsGAQQB
# gjcUAgQMHgoAUwB1AGIAQwBBMA8GA1UdEwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAU
# ci06AjGQQ7kUBU7h6qfHMdEjiTQwWgYDVR0fBFMwUTBPoE2gS4ZJaHR0cDovL2Ny
# bC5taWNyb3NvZnQuY29tL3BraS9jcmwvcHJvZHVjdHMvTWljUm9vQ2VyQXV0MjAx
# MV8yMDExXzAzXzIyLmNybDBeBggrBgEFBQcBAQRSMFAwTgYIKwYBBQUHMAKGQmh0
# dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2kvY2VydHMvTWljUm9vQ2VyQXV0MjAx
# MV8yMDExXzAzXzIyLmNydDANBgkqhkiG9w0BAQwFAAOCAgEAFJQfOChP7onn6fLI
# MKrSlN1WYKwDFgAddymOUO3FrM8d7B/W/iQ6DxXsDn7D5W4wMwYeLystcEqfkjz4
# NURRgazyMu5yRzQh4LqjA4tStTcJh1opExo7nn5PuPBYnbu0+THSuVHTe0VTTPVh
# ily/piFrDo3axQ9P4C+Ol5yet+2gTfekICS5xS+cYfSIvgn0JksVBVMYVI5QFu/q
# hnLhsEFEUzG8fvv0hjgkO+lkpV9ty6GkN4vdnd7ya6Q6aR9y34aiM1qmxaxBi6OU
# nyNl6fkuun/diTFnYDLTppOkr/mg5WSfCiDVMNCxtj4wPKC5OmHm1DQIt/MNokbb
# H3UGsFP1QbzsLocuSqLCvH09Io3fDPTmscR9Y75G4qX7RTX8AdBPo0I6OEojf39z
# uFZt0qOHm65YWQE69cZM2ueE1MB05dNNgHK9gTE7zKvK/fg8B2qjW88MT/WF5V5u
# vZGtqa9FSL2RazArA+rDPuf6JGYz4HpgMZHB4S6szWSKYBv0VisCzfxgeU+dquXW
# 9bd0auYlOB58DPcOYKdc3Se94g+xL4pcEhbB54JOgAkwYTu/9dLeH2pDqeJZAABV
# DWRQCaXfO5LgyKwKCLYXpigrZYCjUSBcr+Ve8PFWMhVTQl0v4q8J/AUmQN5W4n10
# 1cY2L4A7GTQG1h32HHAvfQESWP0xghnlMIIZ4QIBATBuMFcxCzAJBgNVBAYTAlVT
# MR4wHAYDVQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xKDAmBgNVBAMTH01pY3Jv
# c29mdCBDb2RlIFNpZ25pbmcgUENBIDIwMjQCEzMAAAIdTRnITtcPV0gAAAAAAh0w
# DQYJYIZIAWUDBAIBBQCgga4wGQYJKoZIhvcNAQkDMQwGCisGAQQBgjcCAQQwHAYK
# KwYBBAGCNwIBCzEOMAwGCisGAQQBgjcCARUwLwYJKoZIhvcNAQkEMSIEIKp8/8+8
# WQJbwQpimE4EEyOA9IVgRXReBDZky4Bd9hx3MEIGCisGAQQBgjcCAQwxNDAyoBSA
# EgBNAGkAYwByAG8AcwBvAGYAdKEagBhodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20w
# DQYJKoZIhvcNAQEBBQAEggEAANlQTnU8FnFp559YnJ6Hdi2SxJVhs8FWxPBxvp8H
# aFTmejoroFd1CSZzd+vYVmNfqMUMTruQBNtydF/9+TAFrUTiZCGxT7bOFo2eGhzL
# h3T838768OCkOBDDTWV8vQTmsCLhJEjdK5qGOoHGbWkL+I8g+nSnuP07NCEzWTu7
# k3kECYEjIo2v2LyhPtdJVpa3HeabVlLSII04ntGbQV8qPqXEXzuBgGm+WgocVFhD
# viIqn70aL1fQnRdXmuKokqJSbTQ0XpPAKG8/IfFZa5xBjqpGLh/0Y0SFbfTycIW4
# zt7+R4V524yYZJLYnWVNwYcFvUD4oyY8vhPW+xd3qUcg4qGCF5cwgheTBgorBgEE
# AYI3AwMBMYIXgzCCF38GCSqGSIb3DQEHAqCCF3AwghdsAgEDMQ8wDQYJYIZIAWUD
# BAIBBQAwggFSBgsqhkiG9w0BCRABBKCCAUEEggE9MIIBOQIBAQYKKwYBBAGEWQoD
# ATAxMA0GCWCGSAFlAwQCAQUABCCn0vdqzBQmnGAp+o+fOP7blJ+cTbgpV33nlsbb
# iqErMwIGaoVY7GDQGBMyMDI2MDgyNzA2MjkzNi4wNDlaMASAAgH0oIHRpIHOMIHL
# MQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UEBxMHUmVk
# bW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMSUwIwYDVQQLExxN
# aWNyb3NvZnQgQW1lcmljYSBPcGVyYXRpb25zMScwJQYDVQQLEx5uU2hpZWxkIFRT
# UyBFU046OTYwMC0wNUUwLUQ5NDcxJTAjBgNVBAMTHE1pY3Jvc29mdCBUaW1lLVN0
# YW1wIFNlcnZpY2WgghHtMIIHIDCCBQigAwIBAgITMwAAAiY1tD5nQ5P2HwABAAAC
# JjANBgkqhkiG9w0BAQsFADB8MQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGlu
# Z3RvbjEQMA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBv
# cmF0aW9uMSYwJAYDVQQDEx1NaWNyb3NvZnQgVGltZS1TdGFtcCBQQ0EgMjAxMDAe
# Fw0yNjAyMTkxOTQwMDJaFw0yNzA1MTcxOTQwMDJaMIHLMQswCQYDVQQGEwJVUzET
# MBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMV
# TWljcm9zb2Z0IENvcnBvcmF0aW9uMSUwIwYDVQQLExxNaWNyb3NvZnQgQW1lcmlj
# YSBPcGVyYXRpb25zMScwJQYDVQQLEx5uU2hpZWxkIFRTUyBFU046OTYwMC0wNUUw
# LUQ5NDcxJTAjBgNVBAMTHE1pY3Jvc29mdCBUaW1lLVN0YW1wIFNlcnZpY2UwggIi
# MA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC//w+ZZIL5RFFpVI8D3ZyuNu8I
# zcAEOD30OLYjh337rXjcrIlOSzpJc4ZeUxEyli6x6F6zm4NR8dbPb9diDp/hOUzH
# WGxiA1Z3RXKBb/4F/ojyvN43SEGWqSfVc3I3BlsYT35ecVAJ9kVf90YOv29tFjJB
# BZkYvrT/DwwyRLscOyP4p+9/lyJjD+ULs3YXBhVrfZ+MbQB+BYKLqRvBKbj/wR9a
# kNrMxQINoGaD5jZO/N/nSsmG2P1zv/cv4gSoMBnWeQIBkjd2I5w1DeXupp2vSiNm
# R5sA2ZkBK3yiQWaJvRxODlkfiyHk9Mkk/TrYTjmjPCbhe+uqhHNRy8UlbOvWsCq0
# tRtUykHv39DgqAfJNrE8OSt835rBzDprrcAhwmgfhoVi4AKeqwikY0nUa48K0Qy8
# 0XT4fiEA3ExEZNaRFo9Nq/GwbfgqKqGmc9xhKuRFcjtua4KHZvnAvpWgEFSOCkov
# Xs/BcLnkEHM9xZ8iUag5CyhNqXYYE/z0pcXdYaNIkQ68EWmuvLm7g9oofV2vOm5G
# VNoghnkWG6nGPo/JwEgmA9oSS0EfvFRMWPA/gpSvF3shArKHnaEpVSSi3DNbyiuY
# iEs9Ko0IkZc8xKFeQRaqGRxrB+2r/7B3X81Tps99KhFwg+wD87od22F2MUg1x7tw
# t3gaVnFk0IZIwUPCGwIDAQABo4IBSTCCAUUwHQYDVR0OBBYEFF3hn9fYJN2Y/Z9L
# VbBPIxAzXHsQMB8GA1UdIwQYMBaAFJ+nFV0AXmJdg/Tl0mWnG1M1GelyMF8GA1Ud
# HwRYMFYwVKBSoFCGTmh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvY3Js
# L01pY3Jvc29mdCUyMFRpbWUtU3RhbXAlMjBQQ0ElMjAyMDEwKDEpLmNybDBsBggr
# BgEFBQcBAQRgMF4wXAYIKwYBBQUHMAKGUGh0dHA6Ly93d3cubWljcm9zb2Z0LmNv
# bS9wa2lvcHMvY2VydHMvTWljcm9zb2Z0JTIwVGltZS1TdGFtcCUyMFBDQSUyMDIw
# MTAoMSkuY3J0MAwGA1UdEwEB/wQCMAAwFgYDVR0lAQH/BAwwCgYIKwYBBQUHAwgw
# DgYDVR0PAQH/BAQDAgeAMA0GCSqGSIb3DQEBCwUAA4ICAQA2Ux0tr9sYCjsq0FRy
# iVpx15OurNXv6Qk7iX+ArVPlz3w4tqjcTNm1dt3tTua2wJMpJhPH8n7UXhmT98d5
# Du44Ll4adnse4SQfVg3QL6aRkXHnJUn8y9iftB/Py22n9xnwPFfj3QlDOSgLuHle
# u97U0iH2ZaluYabWXJihdiYpK8cPHFlqZOAiot0+GD8dP+RMuvpxt/F2LmYelpoZ
# wriiFOUmlxEUV7xJHyZZlDquskeyuq01DTv91N4qM8cfPPhl/2pc4HeMf/nd2Hou
# ifJbDQFNd4WPhLzn0Sy3u1Zh3+S3tjQdqN+dyw60RaV+RXCoOLgFZ3MAg/GoDl+f
# vb5hy/1a71ctX8wEad1Pf6def2pqfl3wFc++hkF8DXXTZofJN4YVaN3InwbAGQDD
# kNK4lqecCixxmSKwidPynGeE5OtvNoK1pkLsm/i8F1RjGczZ/kSF2VDkqG866iQ+
# jVbGOQ6Du3eyyFcFKZoDJ4B5mEAS9aT2SKqllLeybOboH6r67siR5B/2Hnu7+KYu
# YZy0BEadtA6ngG4cnSR9JsrkhhsKmb11ujqwgJyNx92MsoGGwNgN1aI0QID8CsjC
# FwpfmMzlA44xHKYv3hmjxeqBS4uU5rQeiAnVgpJeaVGKm/lzPDtnppGV+7XhRp5b
# 1ZxT/Z7Xxc+I7H7/jCtQDZoaZTCCB3EwggVZoAMCAQICEzMAAAAVxedrngKbSZkA
# AAAAABUwDQYJKoZIhvcNAQELBQAwgYgxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpX
# YXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25kMR4wHAYDVQQKExVNaWNyb3NvZnQg
# Q29ycG9yYXRpb24xMjAwBgNVBAMTKU1pY3Jvc29mdCBSb290IENlcnRpZmljYXRl
# IEF1dGhvcml0eSAyMDEwMB4XDTIxMDkzMDE4MjIyNVoXDTMwMDkzMDE4MzIyNVow
# fDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1Jl
# ZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEmMCQGA1UEAxMd
# TWljcm9zb2Z0IFRpbWUtU3RhbXAgUENBIDIwMTAwggIiMA0GCSqGSIb3DQEBAQUA
# A4ICDwAwggIKAoICAQDk4aZM57RyIQt5osvXJHm9DtWC0/3unAcH0qlsTnXIyjVX
# 9gF/bErg4r25PhdgM/9cT8dm95VTcVrifkpa/rg2Z4VGIwy1jRPPdzLAEBjoYH1q
# UoNEt6aORmsHFPPFdvWGUNzBRMhxXFExN6AKOG6N7dcP2CZTfDlhAnrEqv1yaa8d
# q6z2Nr41JmTamDu6GnszrYBbfowQHJ1S/rboYiXcag/PXfT+jlPP1uyFVk3v3byN
# pOORj7I5LFGc6XBpDco2LXCOMcg1KL3jtIckw+DJj361VI/c+gVVmG1oO5pGve2k
# rnopN6zL64NF50ZuyjLVwIYwXE8s4mKyzbnijYjklqwBSru+cakXW2dg3viSkR4d
# Pf0gz3N9QZpGdc3EXzTdEonW/aUgfX782Z5F37ZyL9t9X4C626p+Nuw2TPYrbqgS
# Uei/BQOj0XOmTTd0lBw0gg/wEPK3Rxjtp+iZfD9M269ewvPV2HM9Q07BMzlMjgK8
# QmguEOqEUUbi0b1qGFphAXPKZ6Je1yh2AuIzGHLXpyDwwvoSCtdjbwzJNmSLW6Cm
# gyFdXzB0kZSU2LlQ+QuJYfM2BjUYhEfb3BvR/bLUHMVr9lxSUV0S2yW6r1AFemzF
# ER1y7435UsSFF5PAPBXbGjfHCBUYP3irRbb1Hode2o+eFnJpxq57t7c+auIurQID
# AQABo4IB3TCCAdkwEgYJKwYBBAGCNxUBBAUCAwEAATAjBgkrBgEEAYI3FQIEFgQU
# KqdS/mTEmr6CkTxGNSnPEP8vBO4wHQYDVR0OBBYEFJ+nFV0AXmJdg/Tl0mWnG1M1
# GelyMFwGA1UdIARVMFMwUQYMKwYBBAGCN0yDfQEBMEEwPwYIKwYBBQUHAgEWM2h0
# dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvRG9jcy9SZXBvc2l0b3J5Lmh0
# bTATBgNVHSUEDDAKBggrBgEFBQcDCDAZBgkrBgEEAYI3FAIEDB4KAFMAdQBiAEMA
# QTALBgNVHQ8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAfBgNVHSMEGDAWgBTV9lbL
# j+iiXGJo0T2UkFvXzpoYxDBWBgNVHR8ETzBNMEugSaBHhkVodHRwOi8vY3JsLm1p
# Y3Jvc29mdC5jb20vcGtpL2NybC9wcm9kdWN0cy9NaWNSb29DZXJBdXRfMjAxMC0w
# Ni0yMy5jcmwwWgYIKwYBBQUHAQEETjBMMEoGCCsGAQUFBzAChj5odHRwOi8vd3d3
# Lm1pY3Jvc29mdC5jb20vcGtpL2NlcnRzL01pY1Jvb0NlckF1dF8yMDEwLTA2LTIz
# LmNydDANBgkqhkiG9w0BAQsFAAOCAgEAnVV9/Cqt4SwfZwExJFvhnnJL/Klv6lwU
# tj5OR2R4sQaTlz0xM7U518JxNj/aZGx80HU5bbsPMeTCj/ts0aGUGCLu6WZnOlNN
# 3Zi6th542DYunKmCVgADsAW+iehp4LoJ7nvfam++Kctu2D9IdQHZGN5tggz1bSNU
# 5HhTdSRXud2f8449xvNo32X2pFaq95W2KFUn0CS9QKC/GbYSEhFdPSfgQJY4rPf5
# KYnDvBewVIVCs/wMnosZiefwC2qBwoEZQhlSdYo2wh3DYXMuLGt7bj8sCXgU6ZGy
# qVvfSaN0DLzskYDSPeZKPmY7T7uG+jIa2Zb0j/aRAfbOxnT99kxybxCrdTDFNLB6
# 2FD+CljdQDzHVG2dY3RILLFORy3BFARxv2T5JL5zbcqOCb2zAVdJVGTZc9d/HltE
# AY5aGZFrDZ+kKNxnGSgkujhLmm77IVRrakURR6nxt67I6IleT53S0Ex2tVdUCbFp
# AUR+fKFhbHP+CrvsQWY9af3LwUFJfn6Tvsv4O+S3Fb+0zj6lMVGEvL8CwYKiexcd
# FYmNcP7ntdAoGokLjzbaukz5m/8K6TT4JDVnK+ANuOaMmdbhIurwJ0I9JZTmdHRb
# atGePu1+oDEzfbzL6Xu/OHBE0ZDxyKs6ijoIYn/ZcGNTTY3ugm2lBRDBcQZqELQd
# VTNYs6FwZvKhggNQMIICOAIBATCB+aGB0aSBzjCByzELMAkGA1UEBhMCVVMxEzAR
# BgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1JlZG1vbmQxHjAcBgNVBAoTFU1p
# Y3Jvc29mdCBDb3Jwb3JhdGlvbjElMCMGA1UECxMcTWljcm9zb2Z0IEFtZXJpY2Eg
# T3BlcmF0aW9uczEnMCUGA1UECxMeblNoaWVsZCBUU1MgRVNOOjk2MDAtMDVFMC1E
# OTQ3MSUwIwYDVQQDExxNaWNyb3NvZnQgVGltZS1TdGFtcCBTZXJ2aWNloiMKAQEw
# BwYFKw4DAhoDFQCi/fMxFtkqr7XMXdsRyWU0lSKHZ6CBgzCBgKR+MHwxCzAJBgNV
# BAYTAlVTMRMwEQYDVQQIEwpXYXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25kMR4w
# HAYDVQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xJjAkBgNVBAMTHU1pY3Jvc29m
# dCBUaW1lLVN0YW1wIFBDQSAyMDEwMA0GCSqGSIb3DQEBCwUAAgUA7jm5ajAiGA8y
# MDI2MDgyNjE5MTM0NloYDzIwMjYwODI3MTkxMzQ2WjB3MD0GCisGAQQBhFkKBAEx
# LzAtMAoCBQDuOblqAgEAMAoCAQACAgVvAgH/MAcCAQACAhPyMAoCBQDuOwrqAgEA
# MDYGCisGAQQBhFkKBAIxKDAmMAwGCisGAQQBhFkKAwKgCjAIAgEAAgMHoSChCjAI
# AgEAAgMBhqAwDQYJKoZIhvcNAQELBQADggEBAAX0FnCR88RCyazLOdZ+TTKQQmmE
# PwfeE/riH4Ie6ckR548QfN1iEqZ8M2baOA/tJcN5nFJnQA5QuVuKAFcdqDwB+E5g
# X3zQzV5EJCB2iKnpKTzhmL4eF8+wkUcWaKPnzfxiAYHJYiF+eRfj8wnTfsRwBG7h
# zxTXe/Wt5aijSji7H48XzIwvgrhVNq6sur2Q2iZwpqfjZWwbexV92jq+zEwXOXIY
# d5wIYDTcp0VwKyabxli8EjbtpgLxwONipKYJneG8ad+hgxdIp3GXKBQEE4PR9Aos
# Rb3d3fVWSRnv7sSAbTj2d04NG5SP+w5PwQXbUhbg1bPVDvIwYhZ5ExKKk+gxggQN
# MIIECQIBATCBkzB8MQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQ
# MA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
# MSYwJAYDVQQDEx1NaWNyb3NvZnQgVGltZS1TdGFtcCBQQ0EgMjAxMAITMwAAAiY1
# tD5nQ5P2HwABAAACJjANBglghkgBZQMEAgEFAKCCAUowGgYJKoZIhvcNAQkDMQ0G
# CyqGSIb3DQEJEAEEMC8GCSqGSIb3DQEJBDEiBCAIDJ7x+mbRGekHKhXp4sLCjzQG
# o3Xnyx+XSqlJDz7W9zCB+gYLKoZIhvcNAQkQAi8xgeowgecwgeQwgb0EIMwyXGFn
# TNsZRBrs6GN/BbV0okaNP3VBYqLFjUsFnbgqMIGYMIGApH4wfDELMAkGA1UEBhMC
# VVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1JlZG1vbmQxHjAcBgNV
# BAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEmMCQGA1UEAxMdTWljcm9zb2Z0IFRp
# bWUtU3RhbXAgUENBIDIwMTACEzMAAAImNbQ+Z0OT9h8AAQAAAiYwIgQg4RWuKsf4
# M+wbtxXql7QbH++jD59EOD9zWtx97APKemcwDQYJKoZIhvcNAQELBQAEggIAt/Cw
# lHOUVxjroklZ5KKJduUwNFuTSc7tKu+o4QXM52K0Xyk5UWof+bJFuhudmD2P16e+
# yl9BGWQG8N4LURDZXtPQOaspZn+Id5HhIBgSv0I/iXQBdRdHT+cKf9370KbVAdAu
# otr11+ujimEKAgqNCfEDktqa90bN+PP8w5NNtPW7o9EmcRhD+j/hZ26VcRaZ4BHD
# vAjhUW37DBtr1bu51GzFYgN4T1VAzTnSsRnojwhv3eJ3V02gtxnSdtirC2zSzbZo
# OpzMUPdVgz6pgRt/NrAtvdDlKxM9K34G8sKR9eZZccAU8Us7mINTfQuI+BEeJ0kv
# urO0sbIJfT/G0aECAZVpMmtfLDECHS9llgUo/j0nVB2svzfFdNe5aIAmreMDqXs7
# O3qnioEUT8nNajuzbzyqkGXka9b7MJmMp06ezoFqUrkdBCY1OszU3jat5gt1E8eX
# NvRXIE2BxYU2wn9UaSwqTLG65XWtsUh1tB3ecdZtMEJ664Muzu0WC2k5AEXYIAE8
# ZqKk4ST11ibO90bAg2k8vgLyWujPi1tq7jg7EWMQSybP1gYMNSdHhR9qNsIEBod0
# 77eLOgseuxKrioxzw3cBr8+NZ2zRCGmcrKbyxcWnWXq+D8TPq1A3EDprUnt0v2XG
# YzTvYCl2mU04WM7sNdPWKcXOQ9+OIqdqMubHCJQ=
# SIG # End signature block
