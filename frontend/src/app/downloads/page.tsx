"use client";

import { useEffect, useState } from "react";
import { fetchLogFiles, fetchLogPreview, getLogDownloadUrl } from "@/lib/supabase";
import type { LogFile, CsvPreview } from "@/lib/supabase";
import { formatFileSize } from "@/lib/utils";

export default function DownloadsPage() {
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, CsvPreview>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchLogFiles()
      .then(setLogFiles)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const togglePreview = async (filename: string) => {
    if (expandedFile === filename) {
      setExpandedFile(null);
      return;
    }
    setExpandedFile(filename);
    if (!previews[filename]) {
      try {
        const preview = await fetchLogPreview(filename);
        setPreviews((prev) => ({ ...prev, [filename]: preview }));
      } catch (err) {
        console.error("Preview failed:", err);
      }
    }
  };

  const allMachinesLog = logFiles.find((f) => f.name === "AllMachines.csv");
  const machineLogFiles = logFiles.filter((f) => f.name !== "AllMachines.csv");

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Loading log files...
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Logfiles</h2>
        <span className="bg-green-900/30 text-green-400 text-xs px-3 py-1.5 rounded-full">
          CSV Export
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* All Machines Log */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
          <div className="bg-blue-600 px-5 py-3 flex justify-between items-center">
            <h4 className="text-white font-semibold">All Machines Log</h4>
          </div>
          <div className="p-5">
            {allMachinesLog ? (
              <>
                <p className="text-gray-400 text-xs mb-3">
                  Size: {formatFileSize(allMachinesLog.size)} | Last modified:{" "}
                  {new Date(allMachinesLog.lastModified).toLocaleString("de-DE")}
                </p>

                {/* Inline preview */}
                <button
                  onClick={() => togglePreview("AllMachines.csv")}
                  className="text-xs text-cyan-400 hover:text-cyan-300 mb-3"
                >
                  <i className={`bi bi-chevron-${expandedFile === "AllMachines.csv" ? "down" : "right"} mr-1`}></i>
                  {expandedFile === "AllMachines.csv" ? "Hide" : "Show"} preview
                </button>

                {expandedFile === "AllMachines.csv" && previews["AllMachines.csv"] && (
                  <div className="max-h-64 overflow-auto mb-3 border border-gray-700 rounded">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-900 text-yellow-400 sticky top-0">
                        <tr>
                          {previews["AllMachines.csv"].headers.map((h, i) => (
                            <th key={i} className="px-2 py-1 text-left whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {previews["AllMachines.csv"].rows.map((row, i) => (
                          <tr key={i} className="hover:bg-gray-800/50">
                            {row.map((cell, j) => (
                              <td key={j} className="px-2 py-1 whitespace-nowrap text-gray-300">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <a
                  href={getLogDownloadUrl("AllMachines.csv")}
                  className="block w-full bg-green-600 hover:bg-green-700 text-white text-center py-2 rounded text-sm transition-colors"
                >
                  <i className="bi bi-download mr-1"></i> Download CSV
                </a>
              </>
            ) : (
              <div className="text-yellow-400 text-sm">
                <i className="bi bi-exclamation-triangle mr-1"></i>
                No log file available yet.
              </div>
            )}
          </div>
        </div>

        {/* Individual Machine Logs */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
          <div className="bg-blue-600 px-5 py-3">
            <h4 className="text-white font-semibold">Individual Machine Logs</h4>
          </div>
          <div className="p-5">
            {machineLogFiles.length === 0 ? (
              <div className="text-yellow-400 text-sm">
                <i className="bi bi-exclamation-triangle mr-1"></i>
                No machine log files available yet.
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {machineLogFiles.map((file) => {
                  const machineName = file.name.replace(".csv", "");
                  const isExpanded = expandedFile === file.name;

                  return (
                    <div key={file.name} className="border border-gray-700 rounded overflow-hidden">
                      <div className="bg-gray-700/50 px-3 py-2 flex justify-between items-center">
                        <button
                          onClick={() => togglePreview(file.name)}
                          className="text-white text-sm font-medium hover:text-cyan-400 transition-colors"
                        >
                          <i className={`bi bi-chevron-${isExpanded ? "down" : "right"} mr-1`}></i>
                          {machineName}
                        </button>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-400 text-xs">{formatFileSize(file.size)}</span>
                          <a
                            href={getLogDownloadUrl(file.path)}
                            className="bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded text-xs transition-colors"
                          >
                            <i className="bi bi-download"></i>
                          </a>
                        </div>
                      </div>

                      {isExpanded && previews[file.name] && (
                        <div className="max-h-48 overflow-auto border-t border-gray-700">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-900 text-yellow-400 sticky top-0">
                              <tr>
                                {previews[file.name].headers.map((h, i) => (
                                  <th key={i} className="px-2 py-1 text-left whitespace-nowrap">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-800">
                              {previews[file.name].rows.map((row, i) => (
                                <tr key={i} className="hover:bg-gray-800/50">
                                  {row.map((cell, j) => (
                                    <td key={j} className="px-2 py-1 whitespace-nowrap text-gray-300">{cell}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
