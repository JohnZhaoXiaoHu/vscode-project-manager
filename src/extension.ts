/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the MIT License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import fs = require("fs");
import path = require("path");
import * as vscode from "vscode";
import stack = require("../vscode-project-manager-core/src/utils/stack");

import { Locators } from "../vscode-project-manager-core/src/model/locators";
import { Project, ProjectStorage } from "../vscode-project-manager-core/src/model/storage";
import { PathUtils } from "../vscode-project-manager-core/src/utils/PathUtils";

import { Providers } from "../vscode-project-manager-core/src/sidebar/providers";
import { WhatsNewManager } from "../vscode-whats-new/src/Manager";
import { WhatsNewProjectManagerContentProvider } from "./whats-new/ProjectManagerContentProvider";

const PROJECTS_FILE = "projects.json";

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    // Sets storage path if recommended path provided by current version of VS Code.  
    PathUtils.setExtensionContext(context);

    const recentProjects: string = context.globalState.get<string>("recent", "");
    const aStack: stack.StringStack = new stack.StringStack();
    aStack.fromString(recentProjects);

    // load the projects
    const projectStorage: ProjectStorage = new ProjectStorage(getProjectFilePath());

    const locators: Locators = new Locators(aStack);
    const providerManager: Providers = new Providers(context, locators, projectStorage);
    locators.setProviderManager(providerManager);

    const provider = new WhatsNewProjectManagerContentProvider();
    const viewer = new WhatsNewManager(context).registerContentProvider("project-manager", provider);
    viewer.showPageInActivation();
    context.subscriptions.push(vscode.commands.registerCommand("projectManager.whatsNew", () => viewer.showPage()));

    vscode.commands.registerCommand("projectManager.open", (node: string | any) => {
        let uri: vscode.Uri;
        if (typeof node === "string") {
            uri = vscode.Uri.file(node);
        } else {
            uri = vscode.Uri.file(node.command.arguments[0]);
        }
        vscode.commands.executeCommand("vscode.openFolder", uri, false)
            .then(
            value => ({}),  // done
            value => vscode.window.showInformationMessage("Could not open the project!"));
    });
    vscode.commands.registerCommand("projectManager.openInNewWindow", node => {
        const uri: vscode.Uri = vscode.Uri.file(node.command.arguments[0]);
        vscode.commands.executeCommand("vscode.openFolder", uri, true)
            .then(
            value => ({}),  // done
            value => vscode.window.showInformationMessage("Could not open the project!"));
    });

    // register commands (here, because it needs to be used right below if an invalid JSON is present)
    vscode.commands.registerCommand("projectManager.saveProject", () => saveProject());
    vscode.commands.registerCommand("projectManager.refreshProjects", () => refreshProjects(true, true));
    locators.registerCommands();
    vscode.commands.registerCommand("projectManager.editProjects", () => editProjects());
    vscode.commands.registerCommand("projectManager.listProjects", () => listProjects(false));
    vscode.commands.registerCommand("projectManager.listProjectsNewWindow", () => listProjects(true));
    vscode.commands.registerCommand("projectManager.saveFirstProject", () => saveProject());

    // new commands (ActivityBar)
    vscode.commands.registerCommand("projectManager.addToWorkspace", (node) => addProjectToWorkspace(node));
    vscode.commands.registerCommand("projectManager.deleteProject", (node) => deleteProject(node));
    vscode.commands.registerCommand("projectManager.renameProject", (node) => renameProject(node));
    vscode.commands.registerCommand("projectManager.addToFavorites", (node) => saveProject(node));
    vscode.commands.registerCommand("projectManager.toggleProjectEnabled", (node) => toggleProjectEnabled(node));

    loadProjectsFile();

    // // new place to register TreeView
    providerManager.showTreeViewFromAllProviders();

    fs.watchFile(getProjectFilePath(), {interval: 100}, (prev, next) => {
        loadProjectsFile();
        providerManager.projectProviderStorage.refresh();
    });

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(cfg => {
        if (cfg.affectsConfiguration("projectManager.git") || cfg.affectsConfiguration("projectManager.hg") ||
            cfg.affectsConfiguration("projectManager.vscode") || cfg.affectsConfiguration("projectManager.svn") || 
            cfg.affectsConfiguration("projectManager.any") || 
            cfg.affectsConfiguration("projectManager.cacheProjectsBetweenSessions")) {
            refreshProjects();
        }
    }));

    let statusItem: vscode.StatusBarItem;
    showStatusBar();

    // function commands
    function showStatusBar(projectName?: string) {
        const showStatusConfig = vscode.workspace.getConfiguration("projectManager").get("showProjectNameInStatusBar");
        // multi-root - decide do use the "first folder" as the original "rootPath"
        // let currentProjectPath = vscode.workspace.rootPath;
        const workspace0 = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined;
        const currentProjectPath = workspace0 ? workspace0.uri.fsPath : undefined;

        if (!showStatusConfig || !currentProjectPath) { return; }

        if (!statusItem) {
            statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        }
        statusItem.text = "$(file-directory) ";
        statusItem.tooltip = currentProjectPath;

        const openInNewWindow: boolean = vscode.workspace.getConfiguration("projectManager").get("openInNewWindowWhenClickingInStatusBar", false);
        if (openInNewWindow) {
            statusItem.command = "projectManager.listProjectsNewWindow";
        } else {
            statusItem.command = "projectManager.listProjects";
        }

        // if we have a projectName, we don't need to search.
        if (projectName) {
            statusItem.text += projectName;
            statusItem.show();
            return;
        }

        if (projectStorage.length() === 0) {
            return;
        }

        let foundProject: Project = projectStorage.existsWithRootPath(currentProjectPath);
        if (!foundProject) {
            foundProject = locators.vscLocator.existsWithRootPath(currentProjectPath);
        }
        if (!foundProject) {
            foundProject = locators.gitLocator.existsWithRootPath(currentProjectPath);
        }
        if (!foundProject) {
            foundProject = locators.mercurialLocator.existsWithRootPath(currentProjectPath);
        }
        if (!foundProject) {
            foundProject = locators.svnLocator.existsWithRootPath(currentProjectPath);
        }
        if (!foundProject) {
            foundProject = locators.anyLocator.existsWithRootPath(currentProjectPath);
        }
        if (foundProject) {
            statusItem.text += foundProject.name;
            statusItem.show();
        }
    }

    function updateStatusBar(oldName: string, oldPath: string, newName: string): void {
        if (statusItem.text === "$(file-directory) " + oldName && statusItem.tooltip === oldPath) {
            statusItem.text = "$(file-directory) " + newName;
        }
    }

    function refreshProjects(showMessage?: boolean, forceRefresh?: boolean) {

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Refreshing Projects",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "VSCode" });
            const rvscode = await locators.vscLocator.refreshProjects(forceRefresh);
        
            progress.report({ message: "Git" });
            const rgit = await locators.gitLocator.refreshProjects(forceRefresh);
        
            progress.report({ message: "Mercurial" });
            const rmercurial = await locators.mercurialLocator.refreshProjects(forceRefresh);
        
            progress.report({ message: "SVN" });
            const rsvn = await locators.svnLocator.refreshProjects(forceRefresh);

            progress.report({ message: "Any" });
            const rany = await locators.anyLocator.refreshProjects(forceRefresh);

            if (rvscode || rgit || rmercurial || rsvn || rany || forceRefresh) {
                progress.report({ message: "Activity Bar"});
                if (rvscode || forceRefresh) {
                    providerManager.projectProviderVSCode.refresh();
                }
                if (rgit || forceRefresh) {
                    providerManager.projectProviderGit.refresh();
                }
                if (rmercurial || forceRefresh) {
                    providerManager.projectProviderMercurial.refresh();
                }
                if (rsvn || forceRefresh) {
                    providerManager.projectProviderSVN.refresh();
                }
                if (rany || forceRefresh) {
                    providerManager.projectProviderAny.refresh();
                }
                providerManager.showTreeViewFromAllProviders();
            }

            if (showMessage) {
                vscode.window.showInformationMessage("The projects have been refreshed!");
            }
        })
    }

    function editProjects() {
        if (fs.existsSync(getProjectFilePath())) {
            vscode.workspace.openTextDocument(getProjectFilePath()).then(doc => {
                vscode.window.showTextDocument(doc);
            });
        } else {
            const optionEditProject = <vscode.MessageItem> {
                title: "Yes, edit manually"
            };
            vscode.window.showErrorMessage("No projects saved yet! You should open a folder and use Save Project instead. Do you really want to edit manually? ", optionEditProject).then(option => {
                // nothing selected
                if (typeof option === "undefined") {
                    return;
                }

                if (option.title === "Yes, edit manually") {
                    projectStorage.push("Project Name", "Root Path", "");
                    projectStorage.save();
                    vscode.commands.executeCommand("projectManager.editProjects");
                } else {
                    return;
                }
            });
        }
    }

    function saveProject(node?: any) {
        let wpath: string;
        let rootPath: string;

        if (node) {
            wpath = node.label; 
            rootPath = node.command.arguments[0];
        } else {
            // Display a message box to the user
            // let wpath = vscode.workspace.rootPath;
            const workspace0 = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined;
            rootPath = workspace0 ? workspace0.uri.fsPath : undefined;

            if (!rootPath) {
                vscode.window.showInformationMessage("Open a folder first to save a project");
                return;
            }
    
            if (process.platform === "win32") {
                wpath = rootPath.substr(rootPath.lastIndexOf("\\") + 1);
            } else {
                wpath = rootPath.substr(rootPath.lastIndexOf("/") + 1);
            }    
        }

        // ask the PROJECT NAME (suggest the )
        const ibo = <vscode.InputBoxOptions> {
            prompt: "Project Name",
            placeHolder: "Type a name for your project",
            value: wpath
        };

        vscode.window.showInputBox(ibo).then(projectName => {
            if (typeof projectName === "undefined") {
                return;
            }

            // 'empty'
            if (projectName === "") {
                vscode.window.showWarningMessage("You must define a name for the project.");
                return;
            }
   
            if (!projectStorage.exists(projectName)) {
                aStack.push(projectName);
                context.globalState.update("recent", aStack.toString());
                projectStorage.push(projectName, rootPath, "");
                projectStorage.save();
                vscode.window.showInformationMessage("Project saved!");
                if (!node) {
                    showStatusBar(projectName);
                }
            } else {
                const optionUpdate = <vscode.MessageItem> {
                    title: "Update"
                };
                const optionCancel = <vscode.MessageItem> {
                    title: "Cancel"
                };

                vscode.window.showInformationMessage("Project already exists!", optionUpdate, optionCancel).then(option => {
                    // nothing selected
                    if (typeof option === "undefined") {
                        return;
                    }

                    if (option.title === "Update") {
                        aStack.push(projectName);
                        context.globalState.update("recent", aStack.toString());
                        projectStorage.updateRootPath(projectName, rootPath);
                        projectStorage.save();
                        vscode.window.showInformationMessage("Project saved!");
                        if (!node) {
                            showStatusBar(projectName);
                        }
                        return;
                    } else {
                        return;
                    }
                });
            }
        });
    }

    function getProjects(itemsSorted: any[]): Promise<{}> {

        return new Promise((resolve, reject) => {

            resolve(itemsSorted);

        });
    }

    function listProjects(forceNewWindow: boolean) {
        let items = [];
        items = projectStorage.map();
        items = locators.sortGroupedList(items);

        function onRejectListProjects(reason) {
            vscode.commands.executeCommand("setContext", "inProjectManagerList", false);
            vscode.window.showInformationMessage("Error loading projects: ${reason}");
        }

        // promisses
        function onResolve(selected) {
            vscode.commands.executeCommand("setContext", "inProjectManagerList", false);
            if (!selected) {
                return;
            }

            if (!fs.existsSync(selected.description.toString())) {

                if (selected.label.substr(0, 2) === "$(") {
                    vscode.window.showErrorMessage("Path does not exist or is unavailable.");
                    return;
                }

                const optionUpdateProject = <vscode.MessageItem> {
                    title: "Update Project"
                };
                const optionDeleteProject = <vscode.MessageItem> {
                    title: "Delete Project"
                };

                vscode.window.showErrorMessage("The project has an invalid path. What would you like to do?", optionUpdateProject, optionDeleteProject).then(option => {
                    // nothing selected
                    if (typeof option === "undefined") {
                        return;
                    }

                    if (option.title === "Update Project") {
                        vscode.commands.executeCommand("projectManager.editProjects");
                    } else { // Update Project
                        projectStorage.pop(selected.label);
                        projectStorage.save();
                        return;
                    }
                });
            } else {
                // project path
                let projectPath = selected.description;
                projectPath = PathUtils.normalizePath(projectPath);

                // update MRU
                aStack.push(selected.label);
                context.globalState.update("recent", aStack.toString());

                const uri: vscode.Uri = vscode.Uri.file(projectPath);
                vscode.commands.executeCommand("vscode.openFolder", uri, forceNewWindow)
                    .then(
                    value => ({}),  // done
                    value => vscode.window.showInformationMessage("Could not open the project!"));
            }
        }

        const options = <vscode.QuickPickOptions> {
            matchOnDescription: vscode.workspace.getConfiguration("projectManager").get("filterOnFullPath", false),
            matchOnDetail: false,
            placeHolder: "Loading Projects (pick one to open)"
        };

        getProjects(items)
            .then((folders) => {
                return locators.getLocatorProjects(<any[]> folders, locators.vscLocator);
            })
            .then((folders) => {
                return locators.getLocatorProjects(<any[]> folders, locators.gitLocator);
            })
            .then((folders) => {
                return locators.getLocatorProjects(<any[]> folders, locators.mercurialLocator);
            })
            .then((folders) => {
                return locators.getLocatorProjects(<any[]> folders, locators.svnLocator);
            })
            .then((folders) => {
                return locators.getLocatorProjects(<any[]> folders, locators.anyLocator);
            })
            .then((folders) => { // sort
                if ((<any[]> folders).length === 0) {
                    vscode.window.showInformationMessage("No projects saved yet!");
                    return;
                } else {
                    if (!vscode.workspace.getConfiguration("projectManager").get("groupList", false)) {
                        folders = locators.sortProjectList(folders);
                    }
                    vscode.commands.executeCommand("setContext", "inProjectManagerList", true);
                    vscode.window.showQuickPick(<any[]> folders, options)
                        .then(onResolve, onRejectListProjects);
                }
            });
    }

    function loadProjectsFile() {
        const errorLoading: string = projectStorage.load();
        // how to handle now, since the extension starts 'at load'?
        if (errorLoading !== "") {
            const optionOpenFile = <vscode.MessageItem> {
                title: "Open File"
            };
            vscode.window.showErrorMessage("Error loading projects.json file. Message: " + errorLoading, optionOpenFile).then(option => {
                // nothing selected
                if (typeof option === "undefined") {
                    return;
                }

                if (option.title === "Open File") {
                    vscode.commands.executeCommand("projectManager.editProjects");
                } else {
                    return;
                }
            });
            return null;
        }
    }

    function getProjectFilePath() {
        let projectFile: string;
        const projectsLocation: string = vscode.workspace.getConfiguration("projectManager").get<string>("projectsLocation");
        if (projectsLocation !== "") {
            projectFile = path.join(projectsLocation, PROJECTS_FILE);
        } else {
            projectFile = PathUtils.getFilePathFromAppData(PROJECTS_FILE);
        }
        return projectFile;
    }

    function addProjectToWorkspace(node: any) {
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? 
            vscode.workspace.workspaceFolders.length : 0, null, { uri: vscode.Uri.file(node.command.arguments[ 0 ]) });
    }

    function deleteProject(node: any) {
        aStack.pop(node.command.arguments[1]);
        projectStorage.pop(node.command.arguments[1]);
        projectStorage.save();
        vscode.window.showInformationMessage("Project successfully deleted!");
    };

    function renameProject(node: any) {
        const oldName: string = node.command.arguments[1];
        // Display a message box to the user
        // ask the NEW PROJECT NAME ()
        const ibo = <vscode.InputBoxOptions> {
            prompt: "New Project Name",
            placeHolder: "Type a new name for the project",
            value: oldName
        };

        vscode.window.showInputBox(ibo).then(newName => {
            if (typeof newName === "undefined") {
                return;
            }

            // 'empty'
            if (newName === "") {
                vscode.window.showWarningMessage("You must define a new name for the project.");
                return;
            }

            if (!projectStorage.exists(newName)) {
                aStack.rename(oldName, newName)
                projectStorage.rename(oldName, newName);
                projectStorage.save();
                vscode.window.showInformationMessage("Project renamed!");
                updateStatusBar(oldName, node.command.arguments[0], newName);
            } else {
                vscode.window.showErrorMessage("Project already exists!");
            }
        });
    };

    function toggleProjectEnabled(node: any, askForUndo: boolean = true) {
        const projectName: string = node.command.arguments[1];
        const enabled: boolean = projectStorage.toggleEnabled(projectName);
        
        if (enabled === undefined) {
            return;
        }

        projectStorage.save();

        if (!askForUndo) {
            return;
        }

        if (enabled) {
            vscode.window.showInformationMessage(`Project "${projectName}" enabled.`, "Undo").then(undo => {
                if (undo) {
                    toggleProjectEnabled(node, false);
                }
            });
        } else {
            vscode.window.showInformationMessage(`Project "${projectName}" disabled.`, "Undo").then(undo => {
                if (undo) {
                    toggleProjectEnabled(node, false);
                }
            });
        }
            
    };
}
