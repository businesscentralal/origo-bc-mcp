#requires -Version 5.0
Param(
    [Parameter(Mandatory=$true)]
    [string] $clientDllPath
)

class ClientContext {

    $events = @()
    $clientSession = $null
    $culture = ""
    $timezone = ""
    $caughtForm = $null
    $debugMode = $false
    $addressUri = $null
    $interactionStart = $null
    $currentInteraction = $null

    ClientContext([string] $serviceUrl, [string] $accessToken, [timespan] $interactionTimeout, [string] $culture, [string] $timezone) {
        $this.Initialize($serviceUrl, ([Microsoft.Dynamics.Framework.UI.Client.AuthenticationScheme]::AzureActiveDirectory), (New-Object Microsoft.Dynamics.Framework.UI.Client.TokenCredential -ArgumentList $accessToken), $interactionTimeout, $culture, $timezone)
    }

    ClientContext([string] $serviceUrl, [string] $accessToken) {
        $this.Initialize($serviceUrl, ([Microsoft.Dynamics.Framework.UI.Client.AuthenticationScheme]::AzureActiveDirectory), (New-Object Microsoft.Dynamics.Framework.UI.Client.TokenCredential -ArgumentList $accessToken), ([timespan]::FromMinutes(10)), 'en-US', '')
    }

    ClientContext([string] $serviceUrl, [pscredential] $credential, [timespan] $interactionTimeout, [string] $culture, [string] $timezone) {
        $this.Initialize($serviceUrl, ([Microsoft.Dynamics.Framework.UI.Client.AuthenticationScheme]::UserNamePassword), (New-Object System.Net.NetworkCredential -ArgumentList $credential.UserName, $credential.Password), $interactionTimeout, $culture, $timezone)
    }

    ClientContext([string] $serviceUrl, [pscredential] $credential) {
        $this.Initialize($serviceUrl, ([Microsoft.Dynamics.Framework.UI.Client.AuthenticationScheme]::UserNamePassword), (New-Object System.Net.NetworkCredential -ArgumentList $credential.UserName, $credential.Password), ([timespan]::FromMinutes(10)), 'en-US', '')
    }

    ClientContext([string] $serviceUrl, [timespan] $interactionTimeout, [string] $culture, [string] $timezone) {
        $this.Initialize($serviceUrl, ([Microsoft.Dynamics.Framework.UI.Client.AuthenticationScheme]::Windows), $null, $interactionTimeout, $culture, $timezone)
    }
    
    ClientContext([string] $serviceUrl) {
        $this.Initialize($serviceUrl, ([Microsoft.Dynamics.Framework.UI.Client.AuthenticationScheme]::Windows), $null, ([timespan]::FromMinutes(10)), 'en-US', '')
    }
    
    Initialize([string] $serviceUrl, [Microsoft.Dynamics.Framework.UI.Client.AuthenticationScheme] $authenticationScheme, [System.Net.ICredentials] $credential, [timespan] $interactionTimeout, [string] $culture, [string] $timezone) {
        $this.addressUri = New-Object System.Uri -ArgumentList $serviceUrl
        $this.addressUri = [Microsoft.Dynamics.Framework.UI.Client.ServiceAddressProvider]::ServiceAddress($this.addressUri)
        $jsonClient = New-Object Microsoft.Dynamics.Framework.UI.Client.JsonHttpClient -ArgumentList $this.addressUri, $credential, $authenticationScheme
        $httpClient = ($jsonClient.GetType().GetField("httpClient", [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Instance)).GetValue($jsonClient)
        $httpClient.Timeout = $interactionTimeout
        # Cosmo / container self-signed HTTPS: JsonHttpClient uses System.Net.Http.HttpClient.
        # ServicePointManager callbacks do not cover that stack under pwsh (.NET). Trust here before OpenSession.
        try {
            $flags = [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Instance
            $handler = $null
            foreach ($type in @($httpClient.GetType(), $httpClient.GetType().BaseType)) {
                if (-not $type) { continue }
                foreach ($name in @('_handler', 'handler', '_messageHandler')) {
                    $field = $type.GetField($name, $flags)
                    if ($field) { $handler = $field.GetValue($httpClient); break }
                }
                if ($handler) { break }
            }
            if ($handler) {
                if ($handler | Get-Member -Name ServerCertificateCustomValidationCallback -ErrorAction SilentlyContinue) {
                    $handler.ServerCertificateCustomValidationCallback = { $true }
                    Write-Host '[MCP] HttpClientHandler ServerCertificateCustomValidationCallback=trust-any'
                }
                elseif ($handler | Get-Member -Name SslOptions -ErrorAction SilentlyContinue) {
                    $handler.SslOptions.RemoteCertificateValidationCallback = { $true }
                    Write-Host '[MCP] SocketsHttpHandler SslOptions callback=trust-any'
                }
                else {
                    Write-Host "[MCP] HttpClient handler type $($handler.GetType().FullName) has no known cert callback"
                }
            }
            else {
                Write-Host '[MCP] Could not reflect HttpClient handler for SSL trust'
            }
        } catch {
            Write-Host "[MCP] HttpClient SSL trust patch skipped: $($_.Exception.Message)"
        }
        $this.clientSession = New-Object Microsoft.Dynamics.Framework.UI.Client.ClientSession -ArgumentList $jsonClient, (New-Object Microsoft.Dynamics.Framework.UI.Client.NonDispatcher), (New-Object 'Microsoft.Dynamics.Framework.UI.Client.TimerFactory[Microsoft.Dynamics.Framework.UI.Client.TaskTimer]')
        $this.culture = $culture
        if ($timezone -eq '') {
            $tz = Get-TimeZone
            $tz = Get-TimeZone -ListAvailable | Where-Object { $_.BaseUtcOffset -eq $tz.BaseUtcOffset -and $_.SupportsDaylightSavingTime -eq $tz.SupportsDaylightSavingTime } | Select-Object -First 1
            if ($tz) {
                $this.timezone = $tz.Id
            }
        }
        else {
            $this.timezone = $timezone
        }
        $this.OpenSession()
    }

    OpenSession() {
        $Global:OpenClientContext = $this
        $clientSessionParameters = New-Object Microsoft.Dynamics.Framework.UI.Client.ClientSessionParameters
        $clientSessionParameters.CultureId = $this.culture
        $clientSessionParameters.UICultureId = $this.culture
        $clientSessionParameters.TimeZoneId = $this.timezone
        $clientSessionParameters.AdditionalSettings.Add("IncludeControlIdentifier", $true)
        $this.events += @(Register-ObjectEvent -InputObject $this.clientSession -EventName MessageToShow -Action {
            Write-Host -ForegroundColor Yellow "Message : $($EventArgs.Message)"
            if ($Global:OpenClientContext) {
                if ($Global:OpenClientContext.debugMode) {
                    try {
                        $Global:OpenClientContext.GetAllForms() | ForEach-Object {
                            $formInfo = $Global:OpenClientContext.GetFormInfo($_)
                            if ($formInfo) {
                                Write-Host -ForegroundColor Yellow "Title: $($formInfo.title)"
                                Write-Host -ForegroundColor Yellow "Title: $($formInfo.identifier)"
                                $formInfo.controls | ConvertTo-Json -Depth 99 | Out-Host
                            }
                        }
                    }
                    catch {
                        Write-Host "Exception when enumerating forms"
                    }
                }
            }
        })
        $this.events += @(Register-ObjectEvent -InputObject $this.clientSession -EventName CommunicationError -Action {
            Write-Host -ForegroundColor Red "CommunicationError : $($EventArgs.Exception.Message)"
            Get-PSCallStack | Write-Host -ForegroundColor Red
            if ($Global:OpenClientContext) {
                Write-Host -ForegroundColor Red "Current Interaction: $($Global:OpenClientContext.currentInteraction.ToString())"
                Write-Host -ForegroundColor Red "Time spend: $(([DateTime]::Now - $Global:OpenClientContext.interactionStart).Seconds) seconds"
                if ($Global:OpenClientContext.debugMode) {
                    if ($null -ne $EventArgs.Exception.InnerException) {
                        Write-Host -ForegroundColor Red "CommunicationError InnerException : $($EventArgs.Exception.InnerException)"    
                    }
                    try {
                        $Global:OpenClientContext.GetAllForms() | ForEach-Object {
                            $formInfo = $Global:OpenClientContext.GetFormInfo($_)
                            if ($formInfo) {
                                Write-Host -ForegroundColor Yellow "Title: $($formInfo.title)"
                                Write-Host -ForegroundColor Yellow "Title: $($formInfo.identifier)"
                                $formInfo.controls | ConvertTo-Json -Depth 99 | Out-Host
                            }
                        }
                    }
                    catch {
                        Write-Host "Exception when enumerating forms"
                    }
                }
            }
        })
        $this.events += @(Register-ObjectEvent -InputObject $this.clientSession -EventName UnhandledException -Action {
            Write-Host -ForegroundColor Red "UnhandledException : $($EventArgs.Exception.Message)"
            Get-PSCallStack | Write-Host -ForegroundColor Red
            if ($Global:OpenClientContext) {
                Write-Host -ForegroundColor Red "Current Interaction: $($Global:OpenClientContext.currentInteraction.ToString())"
                Write-Host -ForegroundColor Red "Time spend: $(([DateTime]::Now - $Global:OpenClientContext.interactionStart).Seconds) seconds"
                if ($Global:OpenClientContext.debugMode) {
                    if ($null -ne $EventArgs.Exception.InnerException) {
                        Write-Host -ForegroundColor Red "UnhandledException InnerException : $($EventArgs.Exception.InnerException)"    
                    }
                    try {
                        $Global:OpenClientContext.GetAllForms() | ForEach-Object {
                            $formInfo = $Global:OpenClientContext.GetFormInfo($_)
                            if ($formInfo) {
                                Write-Host -ForegroundColor Yellow "Title: $($formInfo.title)"
                                Write-Host -ForegroundColor Yellow "Title: $($formInfo.identifier)"
                                $formInfo.controls | ConvertTo-Json -Depth 99 | Out-Host
                            }
                        }
                    }
                    catch {
                        Write-Host "Exception when enumerating forms"
                    }
                }
            }
        })
        $this.events += @(Register-ObjectEvent -InputObject $this.clientSession -EventName InvalidCredentialsError -Action {
            Write-Host -ForegroundColor Red "InvalidCredentialsError"
            Get-PSCallStack | Write-Host -ForegroundColor Red
        })
        $this.events += @(Register-ObjectEvent -InputObject $this.clientSession -EventName UriToShow -Action {
            Write-Host -ForegroundColor Yellow "UriToShow : $($EventArgs.UriToShow)"
        })
        $this.events += @(Register-ObjectEvent -InputObject $this.clientSession -EventName LookupFormToShow -Action { 
            Write-Host -ForegroundColor Yellow "Open Lookup form"
        })
        $this.events += @(Register-ObjectEvent -InputObject $this.clientSession -EventName DialogToShow -Action {
            $form = $EventArgs.DialogToShow
            if ($Global:OpenClientContext) {
                if ($Global:OpenClientContext.debugMode) {
                    Write-Host -ForegroundColor Yellow "Show dialog $($form.ControlIdentifier)"
                    $formInfo = $Global:OpenClientContext.GetFormInfo($form)
                    if ($formInfo) {
                        Write-Host -ForegroundColor Yellow "Title: $($formInfo.title)"
                        #$formInfo.controls | ConvertTo-Json -Depth 99 | Out-Host
                    }
                }
                if ( $form.ControlIdentifier -eq "00000000-0000-0000-0800-0000836bd2d2" ) {
                    $errorControl = $form.ContainedControls | Where-Object { $_ -is [Microsoft.Dynamics.Framework.UI.Client.ClientStaticStringControl] } | Select-Object -First 1                
                    Write-Host -ForegroundColor Red "ERROR DIALOG: $($errorControl.StringValue)"
                    $Global:OpenClientContext.CloseForm($form)
                    throw "$($errorControl.StringValue)"
                }
                elseif ( $form.ControlIdentifier -eq "00000000-0000-0000-0300-0000836bd2d2" ) {
                    $warningControl = $form.ContainedControls | Where-Object { $_ -is [Microsoft.Dynamics.Framework.UI.Client.ClientStaticStringControl] } | Select-Object -First 1                
                    Write-Host -ForegroundColor Yellow "WARNING DIALOG: $($warningControl.StringValue)"
                    $Global:OpenClientContext.CloseForm($form)
                }
                elseif ( $form.ControlIdentifier -eq "{000009ce-0000-0001-0c00-0000836bd2d2}" -or
                         $form.ControlIdentifier -eq "{000009cd-0000-0001-0c00-0000836bd2d2}" ) {
                    $Global:PsTestRunnerCaughtForm = $form
                }
                elseif ( $form.ControlIdentifier -eq '8da61efd-0002-0003-0507-0b0d1113171d') {
                    $infoControl = $form.ContainedControls | Where-Object { $_ -is [Microsoft.Dynamics.Framework.UI.Client.ClientStaticStringControl] } | Select-Object -First 1                
                    Write-Host "INFO DIALOG: $($infoControl.StringValue)"
                    $Global:OpenClientContext.CloseForm($form)
                }
                else {
                    Write-Host -NoNewline "DIALOG: $($form.Name) $($form.Caption) - "
                    $OkAction = $Global:OpenClientContext.GetActionByName($form, 'OK')
                    if ($OkAction) {
                        Write-Host "Invoke OK"
                        $Global:OpenClientContext.InvokeAction($OkAction)
                    }
                    else {
                        Write-Host "close Dialog"
                        $Global:OpenClientContext.CloseForm($form)
                    }
                }
            }
        })
    
        $this.clientSession.OpenSessionAsync($clientSessionParameters)
        $this.Awaitstate([Microsoft.Dynamics.Framework.UI.Client.ClientSessionState]::Ready)
    }
    #
    
    Dispose() {
        $Global:OpenClientContext = $null

        $this.events | ForEach-Object { Unregister-Event $_.Name }
        $this.events = @()
    
        try {
            if ($this.clientSession -and ($this.clientSession.State -ne ([Microsoft.Dynamics.Framework.UI.Client.ClientSessionState]::Closed))) {
                $this.clientSession.CloseSessionAsync()
                $this.AwaitState([Microsoft.Dynamics.Framework.UI.Client.ClientSessionState]::Closed)
            }
        }
        catch {
        }
    }
    
    AwaitState([Microsoft.Dynamics.Framework.UI.Client.ClientSessionState] $state) {
        $now = [DateTime]::Now
        While ($this.clientSession.State -ne $state) {
            Start-Sleep -Milliseconds 100
            $thisstate = $this.clientSession.State
            if ($thisstate -eq [Microsoft.Dynamics.Framework.UI.Client.ClientSessionState]::InError) {
                throw "ClientSession State is InError (Wait time $(([DateTime]::Now - $now).Seconds) seconds)"
            }
            if ($thisstate -eq [Microsoft.Dynamics.Framework.UI.Client.ClientSessionState]::TimedOut) {
                throw "ClientSession State is TimedOut (Wait time $(([DateTime]::Now - $now).Seconds) seconds)"
            }
            if ($thisstate -eq [Microsoft.Dynamics.Framework.UI.Client.ClientSessionState]::Uninitialized) {
                $waited = ([DateTime]::Now - $now).Seconds
                if ($waited -ge 10) {
                    throw "ClientSession State is Uninitialized (Wait time $waited seconds)"
                }
            }
        }
        Start-Sleep -Milliseconds 100
    }
    
    InvokeInteraction([Microsoft.Dynamics.Framework.UI.Client.ClientInteraction] $interaction) {
        $this.interactionStart = [DateTime]::Now
        $this.currentInteraction = $interaction
        $this.clientSession.InvokeInteractionAsync($interaction)
        $this.AwaitState([Microsoft.Dynamics.Framework.UI.Client.ClientSessionState]::Ready)
    }
    
    [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalForm] InvokeInteractionAndCatchForm([Microsoft.Dynamics.Framework.UI.Client.ClientInteraction] $interaction) {
        $Global:PsTestRunnerCaughtForm = $null
        $formToShowEvent = Register-ObjectEvent -InputObject $this.clientSession -EventName FormToShow -Action { 
            $form = $EventArgs.FormToShow
            $Global:PsTestRunnerCaughtForm = $form
            if ($Global:OpenClientContext.debugMode) {
                Write-Host -ForegroundColor Yellow "Show form $($form.ControlIdentifier)"
                $formInfo = $Global:OpenClientContext.GetFormInfo($form)
                if ($formInfo) {
                    Write-Host -ForegroundColor Yellow "Title: $($formInfo.title)"
#                    $formInfo.controls | ConvertTo-Json -Depth 99 | Out-Host
                }
            }
        }
        try {
            $this.InvokeInteraction($interaction)
            if (!($Global:PsTestRunnerCaughtForm)) {
                $this.CloseAllWarningForms()
            }
        } finally {
            Unregister-Event -SourceIdentifier $formToShowEvent.Name
        }
        $form = $Global:PsTestRunnerCaughtForm
        Remove-Variable PsTestRunnerCaughtForm -Scope Global
        return $form
    }
    
    [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalForm] OpenFormWithBookmark([int] $page, [string] $bookmark) {
        try {
            $interaction = New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.OpenFormInteraction
            $interaction.Page = $page
            $interaction.Bookmark = $bookmark
            return $this.InvokeInteractionAndCatchForm($interaction)
        }
        catch {
            return $null
        }
    }

    [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalForm] OpenForm([int] $page) {
        try {
            $interaction = New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.OpenFormInteraction
            $interaction.Page = $page
            return $this.InvokeInteractionAndCatchForm($interaction)
        }
        catch {
            return $null
        }
    }

    CloseForm([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $form) {
        $this.InvokeInteraction((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.CloseFormInteraction -ArgumentList $form))
    }
    
    [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalForm[]]GetAllForms() {
        try {
            $forms = @()
            $this.clientSession.OpenedForms.GetEnumerator() | ForEach-Object { $forms += $_ }
        }
        catch {
            Start-Sleep -Seconds 1
            $forms = @()
            $this.clientSession.OpenedForms.GetEnumerator() | ForEach-Object { $forms += $_ }
        }
        return $forms
    }
    
    [string]GetErrorFromErrorForm() {
        $errorText = ""
        $this.clientSession.OpenedForms.GetEnumerator() | ForEach-Object {
            $form = $_
            if ( $form.ControlIdentifier -eq "00000000-0000-0000-0800-0000836bd2d2" ) {
                $form.ContainedControls | Where-Object { $_ -is [Microsoft.Dynamics.Framework.UI.Client.ClientStaticStringControl] } | ForEach-Object {
                    $errorText = $_.StringValue
                }
            }
        }
        return $errorText
    }
    
    [string]GetWarningFromWarningForm() {
        $warningText = ""
        $this.clientSession.OpenedForms.GetEnumerator() | ForEach-Object {
            $form = $_
            if ( $form.ControlIdentifier -eq "00000000-0000-0000-0300-0000836bd2d2" ) {
                $form.ContainedControls | Where-Object { $_ -is [Microsoft.Dynamics.Framework.UI.Client.ClientStaticStringControl] } | ForEach-Object {
                    $warningText = $_.StringValue
                }
            }
        }
        return $warningText
    }

    [Hashtable]GetFormInfo([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalForm] $form) {
    
        function Dump-RowControl {
            Param(
                [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control
            )
            @{
                "$($control.Name)" = $control.ObjectValue
            }
        }
    
        function Dump-Control {
            Param(
                [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control
            )
    
            $output = @{
                "name" = $control.Name
                "type" = $control.GetType().Name
                "identifier" = $control.ControlIdentifier
            }
            if ($control -is [Microsoft.Dynamics.Framework.UI.Client.ClientGroupControl]) {
                $output += @{
                    "caption" = $control.Caption
                    "mappingHint" = $control.MappingHint
                    "children" = @($control.Children | ForEach-Object { Dump-Control -control $_ })
                }
            } elseif ($control -is [Microsoft.Dynamics.Framework.UI.Client.ClientStaticStringControl]) {
                $output += @{
                    "value" = $control.StringValue
                }
            } elseif ($control -is [Microsoft.Dynamics.Framework.UI.Client.ClientInt32Control]) {
                $output += @{
                    "value" = $control.ObjectValue
                }
            } elseif ($control -is [Microsoft.Dynamics.Framework.UI.Client.ClientStringControl]) {
                $output += @{
                    "value" = $control.stringValue
                }
            } elseif ($control -is [Microsoft.Dynamics.Framework.UI.Client.ClientActionControl]) {
                $output += @{
                    "caption" = $control.Caption
                }
            } elseif ($control -is [Microsoft.Dynamics.Framework.UI.Client.ClientFilterLogicalControl]) {
            } elseif ($control -is [Microsoft.Dynamics.Framework.UI.Client.ClientRepeaterControl]) {
                $output += @{
                    "$($control.name)" = @()
                }
                $index = 0
                while ($true) {
                    if ($index -ge ($control.Offset + $control.DefaultViewport.Count)) {
                        break
                    }
                    $rowIndex = $index - $control.Offset
                    if ($rowIndex -ge $control.DefaultViewport.Count) {
                        break 
                    }
                    $row = $control.DefaultViewport[$rowIndex]
                    $rowoutput = @{}
                    $row.Children | ForEach-Object { $rowoutput += Dump-RowControl -control $_ }
                    $output[$control.name] += $rowoutput
                    $index++
                }
            }
            else {
            }
            $output
        }
    
        return @{
            "title" = "$($form.Name) $($form.Caption)"
            "identifier" = $form.ControlIdentifier
            "controls" = $form.Children | ForEach-Object { Dump-Control -control $_ }
        }
    }
    
    CloseAllForms() {
        $this.GetAllForms() | ForEach-Object { $this.CloseForm($_) }
    }

    CloseAllErrorForms() {
        $this.GetAllForms() | ForEach-Object {
            if ($_.ControlIdentifier -eq "00000000-0000-0000-0800-0000836bd2d2") {
                $this.CloseForm($_)
            }
        }
    }

    CloseAllWarningForms() {
        $this.GetAllForms() | ForEach-Object {
            if ($_.ControlIdentifier -eq "00000000-0000-0000-0300-0000836bd2d2") {
                $this.CloseForm($_)
            }
        }
    }
    
    [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl]GetControlByCaption([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control, [string] $caption) {
        return $control.ContainedControls | Where-Object { $_.Caption.Replace("&","") -eq $caption } | Select-Object -First 1
    }
    
    [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl]GetControlByName([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control, [string] $name) {
        $result = $control.ContainedControls | Where-Object { $_.Name -eq $name } | Select-Object -First 1
        if (-not $result) {
            $result = $control.ContainedControls | Where-Object { $_.Caption -eq $name } | Select-Object -First 1
        }
        return $result
    }

    [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl]GetControlByType([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control, [Type] $type) {
        return $control.ContainedControls | Where-Object { $_ -is $type } | Select-Object -First 1
    }
    
    SaveValue([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control, [string] $newValue) {
        $this.InvokeInteraction((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.SaveValueInteraction -ArgumentList $control, $newValue))
    }
    
    SelectFirstRow([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control) {
        $this.InvokeInteraction((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.InvokeActionInteraction -ArgumentList $control, SelectFirstRow))
    }

    SelectLastRow([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control) {
        $this.InvokeInteraction((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.InvokeActionInteraction -ArgumentList $control, SelectLastRow))
    }

    Refresh([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control) {
        $this.InvokeInteraction((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.InvokeActionInteraction -ArgumentList $control, Refresh))
    }

    ScrollRepeater([Microsoft.Dynamics.Framework.UI.Client.ClientRepeaterControl] $repeater, [int] $by) {
        $this.InvokeInteraction((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.ScrollRepeaterInteraction -ArgumentList $repeater, $by))
    }
    
    ActivateControl([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control) {
        $this.InvokeInteraction((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.ActivateControlInteraction -ArgumentList $control))
    }
    
    [Microsoft.Dynamics.Framework.UI.Client.ClientActionControl]GetActionByCaption([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control, [string] $caption) {
        return $control.ContainedControls | Where-Object { ($_ -is [Microsoft.Dynamics.Framework.UI.Client.ClientActionControl]) -and ($_.Caption.Replace("&","") -eq $caption) } | Select-Object -First 1
    }
    
    [Microsoft.Dynamics.Framework.UI.Client.ClientActionControl]GetActionByName([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $control, [string] $name) {
        $result = $control.ContainedControls | Where-Object { ($_ -is [Microsoft.Dynamics.Framework.UI.Client.ClientActionControl]) -and ($_.Name -eq $name) } | Select-Object -First 1
        if (-not $result) {
            $result = $control.ContainedControls | Where-Object { ($_ -is [Microsoft.Dynamics.Framework.UI.Client.ClientActionControl]) -and ($_.Caption -eq $name) } | Select-Object -First 1
        }
        return $result
    }

    InvokeAction([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $action) {
        $this.InvokeInteraction((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.InvokeActionInteraction -ArgumentList $action))
    }
    
    [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalForm]InvokeActionAndCatchForm([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $action) {
        return $this.InvokeInteractionAndCatchForm((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.InvokeActionInteraction -ArgumentList $action))
    }

    InvokeSystemAction([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $action, [string] $systemAction) {
        $this.InvokeInteraction((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.InvokeActionInteraction -ArgumentList $action, $systemAction))
    }

    [Microsoft.Dynamics.Framework.UI.Client.ClientLogicalForm]InvokeSystemActionAndCatchForm([Microsoft.Dynamics.Framework.UI.Client.ClientLogicalControl] $action, [string] $systemAction) {
        return $this.InvokeInteractionAndCatchForm((New-Object Microsoft.Dynamics.Framework.UI.Client.Interactions.InvokeActionInteraction -ArgumentList $action, $systemAction))
    }
}

# SIG # Begin signature block
# MIInbgYJKoZIhvcNAQcCoIInXzCCJ1sCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCBrI551zQg1s7N0
# bcxt0wd8SqVvwsEHMzIhfufnUEzAS6CCDMkwggYEMIID7KADAgECAhMzAAACHPrN
# xZvoL37EAAAAAAIcMA0GCSqGSIb3DQEBCwUAMFcxCzAJBgNVBAYTAlVTMR4wHAYD
# VQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xKDAmBgNVBAMTH01pY3Jvc29mdCBD
# b2RlIFNpZ25pbmcgUENBIDIwMjQwHhcNMjYwNDE2MTg1OTQxWhcNMjcwNDE1MTg1
# OTQxWjB0MQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UE
# BxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMR4wHAYD
# VQQDExVNaWNyb3NvZnQgQ29ycG9yYXRpb24wggEiMA0GCSqGSIb3DQEBAQUAA4IB
# DwAwggEKAoIBAQDVsZfgOKmM31HPfoWOoNEiw0SlCiIxUMC0I9NMWbucKOw/e9lP
# oAoehQVu6SG65V4EPzrYsnBnFPNoi4/HoOdjhz1qkrEt4I6tEcxXU6oOeY9zGveC
# /3iBeuhLYxM3M/PkcUoebF+Nednm8OkdSPoDu8imViHPQq/8CQUu0WRR4rE+dMRf
# rpVqfmNi2qWCX94T4MsepijGVkwE//tJg0ryAiYdHT34LSnlG/RSBZmQRGWZ5g8j
# qnKjRParSqMft1gvjuUTVgtWNZfgcLFSK5Wa0myrq8OPcgTGGsRgun+tnSS+IxDT
# xVsAPH1OzvPjwomguByhUe/OcvUN0D5Wmp7xAgMBAAGjggGqMIIBpjAOBgNVHQ8B
# Af8EBAMCB4AwHwYDVR0lBBgwFgYKKwYBBAGCN0wIAQYIKwYBBQUHAwMwHQYDVR0O
# BBYEFNoH7a2YDjOSwpkp6DHcmUS7J+0yMFQGA1UdEQRNMEukSTBHMS0wKwYDVQQL
# EyRNaWNyb3NvZnQgSXJlbGFuZCBPcGVyYXRpb25zIExpbWl0ZWQxFjAUBgNVBAUT
# DTIzMDAxMis1MDc1NjkwHwYDVR0jBBgwFoAUf1k/VCHarU/vBeXmo9ctBpQSCDEw
# YAYDVR0fBFkwVzBVoFOgUYZPaHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3BraW9w
# cy9jcmwvTWljcm9zb2Z0JTIwQ29kZSUyMFNpZ25pbmclMjBQQ0ElMjAyMDI0LmNy
# bDBtBggrBgEFBQcBAQRhMF8wXQYIKwYBBQUHMAKGUWh0dHA6Ly93d3cubWljcm9z
# b2Z0LmNvbS9wa2lvcHMvY2VydHMvTWljcm9zb2Z0JTIwQ29kZSUyMFNpZ25pbmcl
# MjBQQ0ElMjAyMDI0LmNydDAMBgNVHRMBAf8EAjAAMA0GCSqGSIb3DQEBCwUAA4IC
# AQAUnEqhaRXe0T3hIJjvdQErEkrA/7bByjn6t5IArODkkRjzkYwtKMc2yYj2quaN
# rLutWw2YZcngKPy1b71YyDJQTy4NDRwaSh9Tw5thrk3NmcPrAHia5vtcBJ1CgtKK
# 7mQbIcQ22d/N3813ayCDDFewu1+jsZmX+r/aTEqaOM4TVxVtRSkuCy8nAXKuChOK
# Li/zA4XuH8iEYqIsj2YoNaeSxVmeGiERXpKdo3dDmYi0kO5w2D8VS4c3+9h6gElY
# BaAAg/dYErBg27qT3vv0zRDJhJufvCNylA8S7/+8H5E/PV5cng6na9VV/w9OV3qu
# uND6zdGa2EX38Glp50F9AIQk3p2xXmcvorDeM4XJ7UlWYBi6g80J1SSOQnInCYFE
# msfUNn3+1AaTJKSJL83quKArTac2pKhu0Yzzzrzo6HrsRiQKzpnRBb1/dMa6P3hz
# 75XbMRBctNsFhZC07WCmjExdLg2eHW5uV0TY8D5+6wozJf7vF3+WHkYPO85Z+BC6
# U4FkNbYNycZ9cE4j1tXRdyDCfml6c0HWPHjNVDObrv9lKt3qUqFpX38VCqVCyNOO
# 1UcXfQiVjJw32U2WUKZjt/neJKHEBsm9kFsLuWzkQ53+qcaSaytmsCnk2gOglrlD
# 5d3kKyvvAw+rzm0lT8K38P6PLxfZQHhu4W8dV7Av8N2ZmDCCBr0wggSloAMCAQIC
# EzMAAAA5O7Y3Gb8GHWcAAAAAADkwDQYJKoZIhvcNAQEMBQAwgYgxCzAJBgNVBAYT
# AlVTMRMwEQYDVQQIEwpXYXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25kMR4wHAYD
# VQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xMjAwBgNVBAMTKU1pY3Jvc29mdCBS
# b290IENlcnRpZmljYXRlIEF1dGhvcml0eSAyMDExMB4XDTI0MDgwODIwNTQxOFoX
# DTM2MDMyMjIyMTMwNFowVzELMAkGA1UEBhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29m
# dCBDb3Jwb3JhdGlvbjEoMCYGA1UEAxMfTWljcm9zb2Z0IENvZGUgU2lnbmluZyBQ
# Q0EgMjAyNDCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANgBnB7jOMeq
# lRYHNa265v4IY9fH8TKhemHfPINe1gpLaV3dhg324WwH06LcHbpnsBukCDNitryo
# 0dtS/EW6I/yEL/bLSY8hKpbfQuWusBPr9qazYcDxCW/qnjb5JsI1s8bNOg3bVATv
# QVL4tcf03aTycsz8QeCdM0l/yHRObJ9QqazM1r6VPEOJ7LL+uEEb73w6QCuhs89a
# 1uv1zerOYMnsneRRwCbpyW11IcggU0cRKDDq1pjVJzIbIF6+oiXXbReOsgeI8zu1
# FyQfK0fVkaya8SmVHQ/tOf23mZ4W9k0Ri22QW9p3UgSC5OUDktKxxcCmGL6tXLfO
# GSWHIIV4YrTJTT6PNty5REojHJuZHArkF9VnHTERWoTjAzfI3kP+5b4alUdhgAZ7
# ttOu1bVnXfHaqPYl2rPs20ji03LOVWsh/radgE17es5hL+t6lV0eVHrVhsssROWJ
# uz2MXMCt7iw7lFPG9LXKGjsmonn2gotGdHIuEg5JnJMJVmixd5LRlkmgYRZKzhxS
# CwyoGIq0PhaA7Y+VPct5pCHkijcIIDm0nlkK+0KyepolcqGm0T/GYQRMhHJlGOOm
# VQop36wUVUYklUy++vDWeEgEo4s7hxN6mIbf2MSIQ/iIfMZgJxC69oukMUXCrOC3
# SkE/xIkgpfl22MM1itkZ35nNXkMolU1lAgMBAAGjggFOMIIBSjAOBgNVHQ8BAf8E
# BAMCAYYwEAYJKwYBBAGCNxUBBAMCAQAwHQYDVR0OBBYEFH9ZP1Qh2q1P7wXl5qPX
# LQaUEggxMBkGCSsGAQQBgjcUAgQMHgoAUwB1AGIAQwBBMA8GA1UdEwEB/wQFMAMB
# Af8wHwYDVR0jBBgwFoAUci06AjGQQ7kUBU7h6qfHMdEjiTQwWgYDVR0fBFMwUTBP
# oE2gS4ZJaHR0cDovL2NybC5taWNyb3NvZnQuY29tL3BraS9jcmwvcHJvZHVjdHMv
# TWljUm9vQ2VyQXV0MjAxMV8yMDExXzAzXzIyLmNybDBeBggrBgEFBQcBAQRSMFAw
# TgYIKwYBBQUHMAKGQmh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2kvY2VydHMv
# TWljUm9vQ2VyQXV0MjAxMV8yMDExXzAzXzIyLmNydDANBgkqhkiG9w0BAQwFAAOC
# AgEAFJQfOChP7onn6fLIMKrSlN1WYKwDFgAddymOUO3FrM8d7B/W/iQ6DxXsDn7D
# 5W4wMwYeLystcEqfkjz4NURRgazyMu5yRzQh4LqjA4tStTcJh1opExo7nn5PuPBY
# nbu0+THSuVHTe0VTTPVhily/piFrDo3axQ9P4C+Ol5yet+2gTfekICS5xS+cYfSI
# vgn0JksVBVMYVI5QFu/qhnLhsEFEUzG8fvv0hjgkO+lkpV9ty6GkN4vdnd7ya6Q6
# aR9y34aiM1qmxaxBi6OUnyNl6fkuun/diTFnYDLTppOkr/mg5WSfCiDVMNCxtj4w
# PKC5OmHm1DQIt/MNokbbH3UGsFP1QbzsLocuSqLCvH09Io3fDPTmscR9Y75G4qX7
# RTX8AdBPo0I6OEojf39zuFZt0qOHm65YWQE69cZM2ueE1MB05dNNgHK9gTE7zKvK
# /fg8B2qjW88MT/WF5V5uvZGtqa9FSL2RazArA+rDPuf6JGYz4HpgMZHB4S6szWSK
# YBv0VisCzfxgeU+dquXW9bd0auYlOB58DPcOYKdc3Se94g+xL4pcEhbB54JOgAkw
# YTu/9dLeH2pDqeJZAABVDWRQCaXfO5LgyKwKCLYXpigrZYCjUSBcr+Ve8PFWMhVT
# Ql0v4q8J/AUmQN5W4n101cY2L4A7GTQG1h32HHAvfQESWP0xghn7MIIZ9wIBATBu
# MFcxCzAJBgNVBAYTAlVTMR4wHAYDVQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24x
# KDAmBgNVBAMTH01pY3Jvc29mdCBDb2RlIFNpZ25pbmcgUENBIDIwMjQCEzMAAAIc
# +s3Fm+gvfsQAAAAAAhwwDQYJYIZIAWUDBAIBBQCgga4wGQYJKoZIhvcNAQkDMQwG
# CisGAQQBgjcCAQQwHAYKKwYBBAGCNwIBCzEOMAwGCisGAQQBgjcCARUwLwYJKoZI
# hvcNAQkEMSIEINxqSQNnPMx6+1c7rsLccIGG0Eb4QqO2dKgkHzvQuROnMEIGCisG
# AQQBgjcCAQwxNDAyoBSAEgBNAGkAYwByAG8AcwBvAGYAdKEagBhodHRwOi8vd3d3
# Lm1pY3Jvc29mdC5jb20wDQYJKoZIhvcNAQEBBQAEggEAMQcOvEMZ3DZ7W0O5MnIs
# jamB6cQdvt+4h91y39nCHK+cnXRyI0jzoTVwKcTUDCmeCh0OyJbMVpilf8LIshSL
# gksjpqY90uYuMxasofUFlTLr2mXgVMeihXJ99RaMygTDMxi5jIj6KPT6t6FC6++I
# HQ9e2TB6POmDNWF9BhRmKd9WGiz6togHLVExf5zdlGOoiwlPkuLHpM6xsXmUnqp+
# wETjtoQQcJb84SFzTC+Mt32MLoJLwMl1RG97yIt3Z9HGYCPIrtl+lBKG/wBQn0Mx
# 2Hxo1a729UuTnrdioEigcK7vfaDQ49swFcf4J5jU741u4e/9dT4BDVpuKIYwqUAX
# n6GCF60wghepBgorBgEEAYI3AwMBMYIXmTCCF5UGCSqGSIb3DQEHAqCCF4YwgheC
# AgEDMQ8wDQYJYIZIAWUDBAIBBQAwggFaBgsqhkiG9w0BCRABBKCCAUkEggFFMIIB
# QQIBAQYKKwYBBAGEWQoDATAxMA0GCWCGSAFlAwQCAQUABCCy6UQih3VYnk7MH9IX
# WSiH7zdadUgM19fUKHMV5k4RwAIGaomFDY02GBMyMDI2MDgyNzA2MjkzNS43Mjla
# MASAAgH0oIHZpIHWMIHTMQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3Rv
# bjEQMA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0
# aW9uMS0wKwYDVQQLEyRNaWNyb3NvZnQgSXJlbGFuZCBPcGVyYXRpb25zIExpbWl0
# ZWQxJzAlBgNVBAsTHm5TaGllbGQgVFNTIEVTTjo1OTFBLTA1RTAtRDk0NzElMCMG
# A1UEAxMcTWljcm9zb2Z0IFRpbWUtU3RhbXAgU2VydmljZaCCEfswggcoMIIFEKAD
# AgECAhMzAAACFI3NI0TuBt9yAAEAAAIUMA0GCSqGSIb3DQEBCwUAMHwxCzAJBgNV
# BAYTAlVTMRMwEQYDVQQIEwpXYXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25kMR4w
# HAYDVQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xJjAkBgNVBAMTHU1pY3Jvc29m
# dCBUaW1lLVN0YW1wIFBDQSAyMDEwMB4XDTI1MDgxNDE4NDgxOFoXDTI2MTExMzE4
# NDgxOFowgdMxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpXYXNoaW5ndG9uMRAwDgYD
# VQQHEwdSZWRtb25kMR4wHAYDVQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xLTAr
# BgNVBAsTJE1pY3Jvc29mdCBJcmVsYW5kIE9wZXJhdGlvbnMgTGltaXRlZDEnMCUG
# A1UECxMeblNoaWVsZCBUU1MgRVNOOjU5MUEtMDVFMC1EOTQ3MSUwIwYDVQQDExxN
# aWNyb3NvZnQgVGltZS1TdGFtcCBTZXJ2aWNlMIICIjANBgkqhkiG9w0BAQEFAAOC
# Ag8AMIICCgKCAgEAyU+nWgCUyvfyGP1zTFkLkdgOutXcVteP/0CeXfrF/66chKl4
# /MZDCQ6E8Ur4kqgCxQvef7Lg1gfso1EWWKG6vix1VxtvO1kPGK4PZKmOeoeL68F6
# +Mw2ERPy4BL2vJKf6Lo5Z7X0xkRjtcvfM9T0HDgfHUW6z1CbgQiqrExs2NH27rWp
# UkyTYrMG6TXy39+GdMOTgXyUDiRGVHAy3EqYNw3zSWusn0zedl6a/1DbnXIcvn9F
# aHzd/96EPNBOCd2vOpS0Ck7kgkjVxwOptsWa8I+m+DA43cwlErPaId84GbdGzo3V
# oO7YhCmQIoRab0d8or5Pmyg+VMl8jeoN9SeUxVZpBI/cQ4TXXKlLDkfbzzSQriVi
# QGJGJLtKS3DTVNuBqpjXLdu2p2Yq9ODPqZCoiNBh4CB6X2iLYUSO8tmbUVLMMEeg
# bvHSLXQR88QNICjFoBBDCDydoTo9/TNkq80mO77wDM04tPdvbMmxT01GTod60JJx
# UGmMTgseghdBGjkN+D6GsUpY7ta7hP9PzLrs+Alxu46XT217bBn6EwJsAYAc9C28
# mKRUcoIZWQRb+McoZaSu2EcSzuIlAaNIQNtGlz2PF3foSeGmc/V7gCGs8AHkiKwX
# zJSPftnsH8O/R3pJw2D/2hHE3JzxH2SrLX1FdI7Drw145PkL0hbFL6MVCCkCAwEA
# AaOCAUkwggFFMB0GA1UdDgQWBBTbX/bs1cSpyTYnYuf/Mt9CPNhwGzAfBgNVHSME
# GDAWgBSfpxVdAF5iXYP05dJlpxtTNRnpcjBfBgNVHR8EWDBWMFSgUqBQhk5odHRw
# Oi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NybC9NaWNyb3NvZnQlMjBUaW1l
# LVN0YW1wJTIwUENBJTIwMjAxMCgxKS5jcmwwbAYIKwYBBQUHAQEEYDBeMFwGCCsG
# AQUFBzAChlBodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NlcnRzL01p
# Y3Jvc29mdCUyMFRpbWUtU3RhbXAlMjBQQ0ElMjAyMDEwKDEpLmNydDAMBgNVHRMB
# Af8EAjAAMBYGA1UdJQEB/wQMMAoGCCsGAQUFBwMIMA4GA1UdDwEB/wQEAwIHgDAN
# BgkqhkiG9w0BAQsFAAOCAgEAP3xp9D4Gu0SH9B+1JH0hswFquINaTT+RjpfEr8Um
# UOeDl4U5uV+i28/eSYXMxgem3yBZywYDyvf4qMXUvbDcllNqRyL2Rv8jSu8wclt/
# VS1+c5cVCJfM+WHvkUr+dCfUlOy9n4exCPX1L6uWwFH5eoFfqPEp3Fw30irMN2So
# nHBK3mB8vDj3D80oJKqe2tatO38yMTiREdC2HD7eVIUWL7d54UtoYxzwkJN1t7gE
# EGosgBpdmwKVYYDO1USWSNmZELglYA4LoVoGDuWbN7mD8VozYBsfkZarOyrJYlF/
# UCDZLB8XaLfrMfMyZTMCOuEuPD4zj8jy/Jt40clrIW04cvLhkhkydBzcrmC2HxeE
# 36gJsh+jzmivS9YvyiPhLkom1FP0DIFr4VlqyXHKagrtnqSF8QyEpqtQS7wS7ZzZ
# F0eZe0fsYD0J1RarbVuDxmWsq45n1vjRdontuGUdmrG2OGeKd8AtiNghfnabVBbg
# pYgcx/eLyW/n40eTbKIlsm0cseyuWvYFyOqQXjoWtL4/sUHxlWIsrjnNarNr+POk
# L8C1jGBCJuvm0UYgjhIaL+XBXavrbOtX9mrZ3y8GQDxWXn3mhqM21ZcGk83xSRqB
# 9ecfGYNRG6g65v635gSzUmBKZWWcDNzwAoxsgEjTFXz6ahfyrBLqshrjJXPKfO+9
# Ar8wggdxMIIFWaADAgECAhMzAAAAFcXna54Cm0mZAAAAAAAVMA0GCSqGSIb3DQEB
# CwUAMIGIMQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UE
# BxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMTIwMAYD
# VQQDEylNaWNyb3NvZnQgUm9vdCBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkgMjAxMDAe
# Fw0yMTA5MzAxODIyMjVaFw0zMDA5MzAxODMyMjVaMHwxCzAJBgNVBAYTAlVTMRMw
# EQYDVQQIEwpXYXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25kMR4wHAYDVQQKExVN
# aWNyb3NvZnQgQ29ycG9yYXRpb24xJjAkBgNVBAMTHU1pY3Jvc29mdCBUaW1lLVN0
# YW1wIFBDQSAyMDEwMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA5OGm
# TOe0ciELeaLL1yR5vQ7VgtP97pwHB9KpbE51yMo1V/YBf2xK4OK9uT4XYDP/XE/H
# ZveVU3Fa4n5KWv64NmeFRiMMtY0Tz3cywBAY6GB9alKDRLemjkZrBxTzxXb1hlDc
# wUTIcVxRMTegCjhuje3XD9gmU3w5YQJ6xKr9cmmvHaus9ja+NSZk2pg7uhp7M62A
# W36MEBydUv626GIl3GoPz130/o5Tz9bshVZN7928jaTjkY+yOSxRnOlwaQ3KNi1w
# jjHINSi947SHJMPgyY9+tVSP3PoFVZhtaDuaRr3tpK56KTesy+uDRedGbsoy1cCG
# MFxPLOJiss254o2I5JasAUq7vnGpF1tnYN74kpEeHT39IM9zfUGaRnXNxF803RKJ
# 1v2lIH1+/NmeRd+2ci/bfV+AutuqfjbsNkz2K26oElHovwUDo9Fzpk03dJQcNIIP
# 8BDyt0cY7afomXw/TNuvXsLz1dhzPUNOwTM5TI4CvEJoLhDqhFFG4tG9ahhaYQFz
# ymeiXtcodgLiMxhy16cg8ML6EgrXY28MyTZki1ugpoMhXV8wdJGUlNi5UPkLiWHz
# NgY1GIRH29wb0f2y1BzFa/ZcUlFdEtsluq9QBXpsxREdcu+N+VLEhReTwDwV2xo3
# xwgVGD94q0W29R6HXtqPnhZyacaue7e3PmriLq0CAwEAAaOCAd0wggHZMBIGCSsG
# AQQBgjcVAQQFAgMBAAEwIwYJKwYBBAGCNxUCBBYEFCqnUv5kxJq+gpE8RjUpzxD/
# LwTuMB0GA1UdDgQWBBSfpxVdAF5iXYP05dJlpxtTNRnpcjBcBgNVHSAEVTBTMFEG
# DCsGAQQBgjdMg30BATBBMD8GCCsGAQUFBwIBFjNodHRwOi8vd3d3Lm1pY3Jvc29m
# dC5jb20vcGtpb3BzL0RvY3MvUmVwb3NpdG9yeS5odG0wEwYDVR0lBAwwCgYIKwYB
# BQUHAwgwGQYJKwYBBAGCNxQCBAweCgBTAHUAYgBDAEEwCwYDVR0PBAQDAgGGMA8G
# A1UdEwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAU1fZWy4/oolxiaNE9lJBb186aGMQw
# VgYDVR0fBE8wTTBLoEmgR4ZFaHR0cDovL2NybC5taWNyb3NvZnQuY29tL3BraS9j
# cmwvcHJvZHVjdHMvTWljUm9vQ2VyQXV0XzIwMTAtMDYtMjMuY3JsMFoGCCsGAQUF
# BwEBBE4wTDBKBggrBgEFBQcwAoY+aHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3Br
# aS9jZXJ0cy9NaWNSb29DZXJBdXRfMjAxMC0wNi0yMy5jcnQwDQYJKoZIhvcNAQEL
# BQADggIBAJ1VffwqreEsH2cBMSRb4Z5yS/ypb+pcFLY+TkdkeLEGk5c9MTO1OdfC
# cTY/2mRsfNB1OW27DzHkwo/7bNGhlBgi7ulmZzpTTd2YurYeeNg2LpypglYAA7AF
# vonoaeC6Ce5732pvvinLbtg/SHUB2RjebYIM9W0jVOR4U3UkV7ndn/OOPcbzaN9l
# 9qRWqveVtihVJ9AkvUCgvxm2EhIRXT0n4ECWOKz3+SmJw7wXsFSFQrP8DJ6LGYnn
# 8AtqgcKBGUIZUnWKNsIdw2FzLixre24/LAl4FOmRsqlb30mjdAy87JGA0j3mSj5m
# O0+7hvoyGtmW9I/2kQH2zsZ0/fZMcm8Qq3UwxTSwethQ/gpY3UA8x1RtnWN0SCyx
# TkctwRQEcb9k+SS+c23Kjgm9swFXSVRk2XPXfx5bRAGOWhmRaw2fpCjcZxkoJLo4
# S5pu+yFUa2pFEUep8beuyOiJXk+d0tBMdrVXVAmxaQFEfnyhYWxz/gq77EFmPWn9
# y8FBSX5+k77L+DvktxW/tM4+pTFRhLy/AsGConsXHRWJjXD+57XQKBqJC4822rpM
# +Zv/Cuk0+CQ1ZyvgDbjmjJnW4SLq8CdCPSWU5nR0W2rRnj7tfqAxM328y+l7vzhw
# RNGQ8cirOoo6CGJ/2XBjU02N7oJtpQUQwXEGahC0HVUzWLOhcGbyoYIDVjCCAj4C
# AQEwggEBoYHZpIHWMIHTMQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3Rv
# bjEQMA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0
# aW9uMS0wKwYDVQQLEyRNaWNyb3NvZnQgSXJlbGFuZCBPcGVyYXRpb25zIExpbWl0
# ZWQxJzAlBgNVBAsTHm5TaGllbGQgVFNTIEVTTjo1OTFBLTA1RTAtRDk0NzElMCMG
# A1UEAxMcTWljcm9zb2Z0IFRpbWUtU3RhbXAgU2VydmljZaIjCgEBMAcGBSsOAwIa
# AxUA2RysX196RXLTwA/P8RFWdUTpUsaggYMwgYCkfjB8MQswCQYDVQQGEwJVUzET
# MBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMV
# TWljcm9zb2Z0IENvcnBvcmF0aW9uMSYwJAYDVQQDEx1NaWNyb3NvZnQgVGltZS1T
# dGFtcCBQQ0EgMjAxMDANBgkqhkiG9w0BAQsFAAIFAO458dQwIhgPMjAyNjA4MjYy
# MzE0MjhaGA8yMDI2MDgyNzIzMTQyOFowdDA6BgorBgEEAYRZCgQBMSwwKjAKAgUA
# 7jnx1AIBADAHAgEAAgIV6DAHAgEAAgITGzAKAgUA7jtDVAIBADA2BgorBgEEAYRZ
# CgQCMSgwJjAMBgorBgEEAYRZCgMCoAowCAIBAAIDB6EgoQowCAIBAAIDAYagMA0G
# CSqGSIb3DQEBCwUAA4IBAQB7Yzrm+C7mV4HO0toc6mf/hq6lXvQwpyhMxGwhT7HF
# 6Q/SZdRlAAStMka7aqtymA57/2gDD5zUTjMJf5bBcVsfsd/eqawImqjX/PRA3HmV
# FBvPj1CGzCUy36xc9ZBkuXsk+Nn/ebig3hd2HQOhBzuABvYBZl9JFRAXcXaxXBsE
# 7pwHWaFTVhEG8MSlBe4v3XH7cwfqPOCYpDAbpcAquxUO/bhZJycHixuXT4OBCOB+
# /9cpJUSJuVySzQbSsE/RhcimWCbvN8WyijyZnw/Cb0GcyfmKiaBpxzszB1fP+a5a
# qN7yLvL6NfHjOrAWOJd/ye2Uq0x4KYkHvloNaAaN2DfvMYIEDTCCBAkCAQEwgZMw
# fDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1Jl
# ZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEmMCQGA1UEAxMd
# TWljcm9zb2Z0IFRpbWUtU3RhbXAgUENBIDIwMTACEzMAAAIUjc0jRO4G33IAAQAA
# AhQwDQYJYIZIAWUDBAIBBQCgggFKMBoGCSqGSIb3DQEJAzENBgsqhkiG9w0BCRAB
# BDAvBgkqhkiG9w0BCQQxIgQgR+ergd6sgUXRrhdG9i/hU06QpjfZKHb2BJbc+v4q
# tnEwgfoGCyqGSIb3DQEJEAIvMYHqMIHnMIHkMIG9BCA2eKvvWx5bcoi43bRO3+Et
# tQUCvyeD2dbXy/6+0xK+xzCBmDCBgKR+MHwxCzAJBgNVBAYTAlVTMRMwEQYDVQQI
# EwpXYXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25kMR4wHAYDVQQKExVNaWNyb3Nv
# ZnQgQ29ycG9yYXRpb24xJjAkBgNVBAMTHU1pY3Jvc29mdCBUaW1lLVN0YW1wIFBD
# QSAyMDEwAhMzAAACFI3NI0TuBt9yAAEAAAIUMCIEIMuYrqJWZoPd3A32sQNN0IdH
# fRSynPNa6/03HHN9ziklMA0GCSqGSIb3DQEBCwUABIICALp/5vAc/44NUOLr+8TR
# BMQ/VHKy9z8SXOKWqbMON21B25MgAsoAn2GQ09ptTEv5ZyTvThZMqAXZwlSL438H
# fXNyjHEN0ykzLU+oKGoyg5NEmnvrnCS3jYp5KyKylaPGkMMx8L7JJUVa8WOzSIQz
# CPMYZf7SEhT72QYh1BcupN+7J/LtlCQI7a4Zh0esA6tc7Eaie2arY48ccRbAjfAd
# xRuAgCrNTrUPEnUjYF4uxd/dTQOcZdjeu2Ub9pvTXiLzyIt3m/zBeU67B5pvCt/Z
# eVdBsN6FoW9biKLEDgdCvYLScMiMjDMHBELZC8FHvfwm9ADN25HHrBFC0oKSLmJO
# vRYE3Ardq3C/B9VJaCkQduXmxnQQdVvgVGjaO9e53OlWGwBx9f8U1ZkeEYOjOhe9
# 7YSTJB+9BLOQDZXabIwvTtUJ8AosvWH/cikRUq19YZ9KPsjoAKTl6+V9PjQvTf7T
# Y1D7ey4/l8iv7FCe5n00wJq1WZfpUrEtkvyB0MHZtKaJN9urwEVH3l9zKQXw7SrF
# y3kYDFypAJcqZnbdSMj/HAi31OKrARK1XKFhWSWn8RUSWLZPzV/VMjkB1PEsDF74
# 7lOMBFS2z1RRcIkLkxANBN1qV2bZrdPOzhgR/TdcDffdu2rnTe45rZsN1q91XcUI
# db6Eo2aiiZsKt5qe1EXwLb6P
# SIG # End signature block
