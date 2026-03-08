using MachineSimulator;
using MachineSimulator.Components;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.AddSingleton<SimSettingsService>();
builder.Services.AddSingleton<SimulatorService>();
builder.Services.AddSingleton<MqttSimService>();

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    app.UseHsts();
}

app.UseStaticFiles();
app.UseAntiforgery();

// Force singleton initialization on startup
_ = app.Services.GetRequiredService<SimulatorService>();
_ = app.Services.GetRequiredService<MqttSimService>();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
