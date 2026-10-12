using System.Net;
using System.Text.Json;
using Dragon.Copilot.Radiologists.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Identity.Client;
using PreDraftReport.Console.QuickStart.Authentication;
using PreDraftReport.Console.QuickStart.Simulation;
using PreDraftReport.Console.QuickStart.Submission;

namespace PreDraftReport.Console.QuickStart;

// The enclosing namespace is named Console, so System.Console needs an alias to stay reachable.
using Console = System.Console;

/// <summary>
/// Submits a pre-draft report the way a Partner's service does, to a simulated Dragon Copilot endpoint.
/// </summary>
public static class Program
{
    private const string DefaultPayloadFileName = "pre-draft-report-ingest-request.json";

    private static readonly Dictionary<string, string> ReasonHints = new(StringComparer.Ordinal)
    {
        ["EnvironmentNotFound"] = "customerTenantId and environmentId don't identify a customer environment.",
        ["ExtensionNotFound"] = "No installed extension has a manifest whose name equals manifestName. If you sent Marketplace IDs, the extension must also have been purchased with that offer and plan.",
        ["MultipleExtensionsMatched"] = "More than one installed extension has this manifest name. Send the Marketplace IDs of the one you mean.",
        ["ToolNotFound"] = "The manifest declares no partnerInitiated tool named toolName with the preDraftReportGeneration capability.",
        ["OrderNotFound"] = "No order in the environment has the accession number in draftReport.imagingStudy.accessionNumber.",
        ["MultipleOrdersMatched"] = "More than one order in the environment has the accession number in draftReport.imagingStudy.accessionNumber.",
    };

    /// <summary>
    /// Runs the sample.
    /// </summary>
    /// <param name="args">Optional path to a payload file. Defaults to the bundled example.</param>
    /// <returns>Zero when the draft report is stored, or was already stored; one otherwise.</returns>
    public static async Task<int> Main(string[] args)
    {
        ArgumentNullException.ThrowIfNull(args);

        SampleSettings settings;
        try
        {
            var configuration = new ConfigurationBuilder()
                .SetBasePath(AppContext.BaseDirectory)
                .AddJsonFile("appsettings.json", optional: false)
                .AddUserSecrets(typeof(Program).Assembly, optional: true)
                .AddEnvironmentVariables()
                .Build();

            settings = SampleSettings.Load(configuration);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or FormatException or InvalidOperationException)
        {
            // A missing or malformed appsettings.json, or a setting that can't be converted to its type.
            Console.WriteLine($"Could not load the settings: {ex.Message}");
            return 1;
        }

        ClientCredentialsTokenProvider? tokenProvider = null;
        if (settings.Authentication.Enabled)
        {
            var missing = MissingAuthenticationSettings(settings.Authentication);
            if (missing.Count > 0)
            {
                Console.WriteLine($"Authentication is enabled, but these settings are empty: {string.Join(", ", missing)}.");
                return 1;
            }

            tokenProvider = new ClientCredentialsTokenProvider(
                settings.Authentication.TenantId,
                settings.Authentication.ClientId,
                settings.Authentication.ClientSecret);
        }

        string payloadPath;
        try
        {
            payloadPath = args.Length > 0
                ? Path.GetFullPath(args[0])
                : Path.Combine(AppContext.BaseDirectory, "MockData", DefaultPayloadFileName);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or NotSupportedException)
        {
            Console.WriteLine($"The payload path '{args[0]}' is not valid: {ex.Message}");
            return 1;
        }

        using var cancellation = new CancellationTokenSource();
        void OnCancelKeyPress(object? sender, ConsoleCancelEventArgs eventArgs)
        {
            // Let the run stop cleanly instead of the process being killed.
            eventArgs.Cancel = true;
            cancellation.Cancel();
        }

        Console.CancelKeyPress += OnCancelKeyPress;
        try
        {
            return await RunAsync(settings, payloadPath, AppContext.BaseDirectory, Console.Out, tokenProvider, cancellation.Token)
                .ConfigureAwait(false);
        }
        finally
        {
            // Unsubscribe before the token source is disposed, so a late Ctrl+C can't cancel a disposed source.
            Console.CancelKeyPress -= OnCancelKeyPress;
        }
    }

    /// <summary>
    /// Loads a payload, acquires a token when one is supplied, submits the payload to the simulated
    /// endpoint and reports what came back.
    /// </summary>
    /// <param name="settings">The sample's settings.</param>
    /// <param name="payloadPath">The payload file to submit.</param>
    /// <param name="baseDirectory">The folder that relative paths in the settings are relative to.</param>
    /// <param name="output">Where to write progress and results.</param>
    /// <param name="tokenProvider">Supplies the access token, or null to submit without one.</param>
    /// <param name="cancellationToken">Cancels the run.</param>
    /// <returns>Zero when the draft report is stored, or was already stored; one otherwise.</returns>
    public static Task<int> RunAsync(
        SampleSettings settings,
        string payloadPath,
        string baseDirectory,
        TextWriter output,
        ITokenProvider? tokenProvider,
        CancellationToken cancellationToken) =>
        RunAsync(settings, payloadPath, baseDirectory, output, tokenProvider, createHandler: null, cancellationToken);

    /// <summary>
    /// Runs the sample, optionally sending requests through a handler other than the simulated endpoint.
    /// </summary>
    /// <param name="settings">The sample's settings.</param>
    /// <param name="payloadPath">The payload file to submit.</param>
    /// <param name="baseDirectory">The folder that relative paths in the settings are relative to.</param>
    /// <param name="output">Where to write progress and results.</param>
    /// <param name="tokenProvider">Supplies the access token, or null to submit without one.</param>
    /// <param name="createHandler">Creates the handler requests are sent through, or null for the simulated endpoint.</param>
    /// <param name="cancellationToken">Cancels the run.</param>
    /// <returns>Zero when the draft report is stored, or was already stored; one otherwise.</returns>
    internal static async Task<int> RunAsync(
        SampleSettings settings,
        string payloadPath,
        string baseDirectory,
        TextWriter output,
        ITokenProvider? tokenProvider,
        Func<SimulatedEnvironment, HttpMessageHandler>? createHandler,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(output);

        try
        {
            return await RunCoreAsync(settings, payloadPath, baseDirectory, output, tokenProvider, createHandler, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await output.WriteLineAsync("Cancelled.").ConfigureAwait(false);
            return 1;
        }
    }

    private static async Task<int> RunCoreAsync(
        SampleSettings settings,
        string payloadPath,
        string baseDirectory,
        TextWriter output,
        ITokenProvider? tokenProvider,
        Func<SimulatedEnvironment, HttpMessageHandler>? createHandler,
        CancellationToken cancellationToken)
    {
        // 1. Load the request. A Partner's service builds it from its model's output instead.
        var request = await LoadRequestAsync(payloadPath, output, cancellationToken).ConfigureAwait(false);
        if (request is null)
        {
            return 1;
        }

        // 2. Acquire an access token, when authentication is on.
        string? accessToken = null;
        if (tokenProvider is not null)
        {
            try
            {
                accessToken = await tokenProvider.GetAccessTokenAsync(cancellationToken).ConfigureAwait(false);
                await output.WriteLineAsync("Acquired an access token for the Partner Communications API.").ConfigureAwait(false);
            }
            catch (MsalException ex)
            {
                await output.WriteLineAsync($"Could not acquire an access token. {ex.ErrorCode}: {ex.Message}").ConfigureAwait(false);
                return 1;
            }
        }

        // 3. Send requests to the simulated endpoint instead of a real Dragon Copilot environment.
        SimulatedEnvironment environment;
        try
        {
            environment = SimulatedEnvironment.Load(settings.Simulation, baseDirectory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // An unreadable manifest or stored results file, or a path in the settings that isn't valid.
            await output.WriteLineAsync($"Could not set up the simulated environment: {ex.Message}").ConfigureAwait(false);
            return 1;
        }

        DescribeEnvironment(environment, output);

        using var handler = CreateHandler(environment, requireAccessToken: tokenProvider is not null, createHandler);
        using var httpClient = new HttpClient(handler, disposeHandler: false)
        {
            BaseAddress = SimulatedDragonCopilotHandler.BaseAddress,
            Timeout = TimeSpan.FromSeconds(Math.Max(1, settings.DragonCopilot.TimeoutSeconds)),
        };

        // 4. Submit the draft report and report the outcome.
        var correlationId = Guid.NewGuid().ToString();
        await output.WriteLineAsync($"Submitting {payloadPath}").ConfigureAwait(false);
        await output.WriteLineAsync(
            $"  POST /api/v1/tenants/{settings.DragonCopilot.CustomerTenantId}/environments/{settings.DragonCopilot.EnvironmentId}/draft-report-ai-results")
            .ConfigureAwait(false);
        await output.WriteLineAsync($"  {DraftReportClient.CorrelationIdHeader}: {correlationId}").ConfigureAwait(false);

        SubmissionResult result;
        try
        {
            result = await new DraftReportClient(httpClient)
                .SubmitAsync(
                    settings.DragonCopilot.CustomerTenantId,
                    settings.DragonCopilot.EnvironmentId,
                    request,
                    accessToken,
                    correlationId,
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            await output.WriteLineAsync($"The request failed: {ex.Message}").ConfigureAwait(false);
            return 1;
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            await output.WriteLineAsync($"No response within {httpClient.Timeout.TotalSeconds} seconds.").ConfigureAwait(false);
            return 1;
        }

        return Report(result, request, output);
    }

    private static List<string> MissingAuthenticationSettings(AuthenticationSettings authentication)
    {
        var missing = new List<string>();
        if (string.IsNullOrWhiteSpace(authentication.TenantId))
        {
            missing.Add("Authentication:TenantId");
        }

        if (string.IsNullOrWhiteSpace(authentication.ClientId))
        {
            missing.Add("Authentication:ClientId");
        }

        if (string.IsNullOrWhiteSpace(authentication.ClientSecret))
        {
            missing.Add("Authentication:ClientSecret");
        }

        return missing;
    }

    private static async Task<DraftReportIngestRequest?> LoadRequestAsync(string payloadPath, TextWriter output, CancellationToken cancellationToken)
    {
        if (!File.Exists(payloadPath))
        {
            await output.WriteLineAsync($"Payload not found: {payloadPath}").ConfigureAwait(false);
            return null;
        }

        try
        {
            var json = await File.ReadAllTextAsync(payloadPath, cancellationToken).ConfigureAwait(false);
            var request = JsonSerializer.Deserialize<DraftReportIngestRequest>(json);
            if (request is null)
            {
                await output.WriteLineAsync($"Payload is empty: {payloadPath}").ConfigureAwait(false);
            }

            return request;
        }
        catch (JsonException ex)
        {
            // Also raised when a required property with no null value, such as aiGenerated, is missing.
            await output.WriteLineAsync($"Payload is not a valid draft report ingest request: {ex.Message}").ConfigureAwait(false);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            await output.WriteLineAsync($"Could not read the payload {payloadPath}: {ex.Message}").ConfigureAwait(false);
            return null;
        }
    }

    private static HttpMessageHandler CreateHandler(
        SimulatedEnvironment environment,
        bool requireAccessToken,
        Func<SimulatedEnvironment, HttpMessageHandler>? createHandler)
    {
        if (createHandler is not null)
        {
            return createHandler(environment);
        }

        return new SimulatedDragonCopilotHandler(environment, requireAccessToken);
    }

    private static void DescribeEnvironment(SimulatedEnvironment environment, TextWriter output)
    {
        output.WriteLine("Simulated Dragon Copilot environment");
        output.WriteLine($"  Customer tenant: {environment.CustomerTenantId}");
        output.WriteLine($"  Environment:     {environment.EnvironmentId}");

        if (environment.Installations.Count == 0)
        {
            output.WriteLine("  Installed:       nothing");
        }

        foreach (var installation in environment.Installations)
        {
            var source = installation.PublisherId is null
                ? "custom app"
                : $"Marketplace offer {installation.PublisherId}/{installation.OfferId}/{installation.PlanId}";

            output.WriteLine(installation.Problem is null
                ? $"  Installed:       {installation.ManifestName} ({source}) from {installation.ManifestPath}"
                : $"  Not installed:   the manifest {installation.ManifestPath} {installation.Problem}");
        }

        output.WriteLine($"  Orders:          {string.Join(", ", environment.Orders)}");
        output.WriteLine($"  Stored results:  {environment.StoredResultsPath}");
        output.WriteLine();
    }

    private static int Report(SubmissionResult result, DraftReportIngestRequest request, TextWriter output)
    {
        output.WriteLine();
        output.WriteLine(result.Reason is null
            ? $"{(int)result.StatusCode} {result.StatusCode}"
            : $"{(int)result.StatusCode} {result.StatusCode}, reason {result.Reason}");
        output.WriteLine($"  {DraftReportClient.CorrelationIdHeader}: {result.CorrelationId}");

        if (result.StatusCode == HttpStatusCode.OK)
        {
            output.WriteLine(
                $"  Stored. Dragon Copilot shows the draft when the radiologist opens the order with accession number {request.DraftReport?.ImagingStudy?.AccessionNumber}.");
            return 0;
        }

        if (result.Reason == "ResultAlreadyStored")
        {
            // Resending the same identifier never stores the draft twice, which is what makes a retry safe.
            output.WriteLine(
                $"  A result with draftReport.identifier {request.DraftReport?.Identifier} is already stored, so nothing was stored again. " +
                "If this was a retry, there's nothing more to do. To replace the draft, submit it with a new identifier.");
            return 0;
        }

        if (result.Body.Length > 0)
        {
            output.WriteLine($"  {result.Body}");
        }

        if (result.Reason is not null && ReasonHints.TryGetValue(result.Reason, out var hint))
        {
            output.WriteLine($"  {hint}");
        }
        else if (result.StatusCode == HttpStatusCode.Unauthorized)
        {
            output.WriteLine("  The access token is missing or invalid. See radiologists/partner-initiated/authentication.md.");
        }

        return 1;
    }
}
