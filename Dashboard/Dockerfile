FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY ["Dashboard/Dashboard.csproj", "Dashboard/"]
RUN dotnet restore "Dashboard/Dashboard.csproj"
COPY . .
WORKDIR "/src/Dashboard"
RUN dotnet publish -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Dashboard.dll"]