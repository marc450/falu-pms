FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY ["MachineSimulator/MachineSimulator.csproj", "MachineSimulator/"]
RUN dotnet restore "MachineSimulator/MachineSimulator.csproj"
COPY . .
WORKDIR "/src/MachineSimulator"
RUN dotnet publish -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "MachineSimulator.dll"]