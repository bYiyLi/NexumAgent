//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

const (
	createSuspended       = 0x00000004
	detachedProcess       = 0x00000008
	killOnJobClose        = 0x00002000
	jobObjectExtendedInfo = 9
	infiniteWait          = 0xffffffff
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var (
	createJobObject          = kernel32.NewProc("CreateJobObjectW")
	setInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	assignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	resumeThread             = kernel32.NewProc("ResumeThread")
	terminateProcess         = kernel32.NewProc("TerminateProcess")
)

type jobBasicLimits struct {
	processTime int64
	jobTime     int64
	flags       uint32
	minWorking  uintptr
	maxWorking  uintptr
	activeCount uint32
	affinity    uintptr
	priority    uint32
	scheduling  uint32
}

type jobIOCounters struct {
	reads, writes, other, readBytes, writeBytes, otherBytes uint64
}

type jobExtendedLimits struct {
	basic         jobBasicLimits
	io            jobIOCounters
	processMemory uintptr
	jobMemory     uintptr
	peakProcess   uintptr
	peakJob       uintptr
}

func nativeNode(program string) string {
	return filepath.Join(program, "runtime", "node.exe")
}

func newKillJob() (syscall.Handle, error) {
	handle, _, err := createJobObject.Call(0, 0)
	if handle == 0 {
		return 0, fmt.Errorf("CreateJobObject: %w", err)
	}
	job := syscall.Handle(handle)
	limits := jobExtendedLimits{}
	limits.basic.flags = killOnJobClose
	ok, _, cause := setInformationJobObject.Call(
		handle, jobObjectExtendedInfo,
		uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits),
	)
	if ok == 0 {
		syscall.CloseHandle(job)
		return 0, fmt.Errorf("SetInformationJobObject: %w", cause)
	}
	return job, nil
}

func inheritedHandle(file *os.File) (syscall.Handle, error) {
	self, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0, err
	}
	var target syscall.Handle
	err = syscall.DuplicateHandle(
		self, syscall.Handle(file.Fd()), self, &target,
		0, true, syscall.DUPLICATE_SAME_ACCESS,
	)
	return target, err
}

// launchOnce starts the Node launcher suspended. Assigning it to the job
// before the first instruction executes eliminates the cleanup race. All
// descendants inherit the job, but none inherits the job *handle*.
func launchOnce(config launchConfig, output *os.File) (uint32, error) {
	job, err := newKillJob()
	if err != nil {
		return 1, err
	}
	defer syscall.CloseHandle(job)

	nul, err := os.OpenFile("NUL", os.O_RDONLY, 0)
	if err != nil {
		return 1, err
	}
	defer nul.Close()
	inputHandle, err := inheritedHandle(nul)
	if err != nil {
		return 1, err
	}
	defer syscall.CloseHandle(inputHandle)
	outputHandle, err := inheritedHandle(output)
	if err != nil {
		return 1, err
	}
	defer syscall.CloseHandle(outputHandle)

	startup := syscall.StartupInfo{
		Cb:        uint32(unsafe.Sizeof(syscall.StartupInfo{})),
		Flags:     syscall.STARTF_USESTDHANDLES,
		StdInput:  inputHandle,
		StdOutput: outputHandle,
		StdErr:    outputHandle,
	}
	// DETACHED_PROCESS (not CREATE_NO_WINDOW) is essential: the latter
	// creates a hidden but still attached console.
	command := syscall.EscapeArg(config.node) + " --experimental-vm-modules " +
		syscall.EscapeArg(config.runner)
	if config.layout == "work" {
		command += " run"
	}
	command += " --profile " + config.profile
	commandPointer, err := syscall.UTF16PtrFromString(command)
	if err != nil {
		return 1, err
	}
	binaryPointer, err := syscall.UTF16PtrFromString(config.node)
	if err != nil {
		return 1, err
	}
	workDir := filepath.Dir(config.program)
	if config.layout == "work" {
		workDir = config.program
	}
	workPointer, err := syscall.UTF16PtrFromString(workDir)
	if err != nil {
		return 1, err
	}
	var child syscall.ProcessInformation
	err = syscall.CreateProcess(
		binaryPointer, commandPointer, nil, nil, true,
		createSuspended|detachedProcess, nil, workPointer, &startup, &child,
	)
	if err != nil {
		return 1, fmt.Errorf("CreateProcess: %w", err)
	}
	defer syscall.CloseHandle(child.Process)
	defer syscall.CloseHandle(child.Thread)

	assigned, _, cause := assignProcessToJobObject.Call(
		uintptr(job), uintptr(child.Process),
	)
	if assigned == 0 {
		terminateProcess.Call(uintptr(child.Process), 1)
		syscall.WaitForSingleObject(child.Process, 30000)
		return 1, fmt.Errorf("AssignProcessToJobObject: %w", cause)
	}
	resumed, _, cause := resumeThread.Call(uintptr(child.Thread))
	if resumed == ^uintptr(0) {
		terminateProcess.Call(uintptr(child.Process), 1)
		syscall.WaitForSingleObject(child.Process, 30000)
		return 1, fmt.Errorf("ResumeThread: %w", cause)
	}
	status, err := syscall.WaitForSingleObject(child.Process, infiniteWait)
	if err != nil || status != syscall.WAIT_OBJECT_0 {
		return 1, fmt.Errorf("WaitForSingleObject: status=%d: %w", status, err)
	}
	var exit uint32
	if err := syscall.GetExitCodeProcess(child.Process, &exit); err != nil {
		return 1, fmt.Errorf("GetExitCodeProcess: %w", err)
	}
	// Closing the job handle here terminates any child subtree still alive
	// after the Launcher exited. No old npm process can race a retry.
	return exit, nil
}

func run(config launchConfig) error {
	if err := os.Setenv("USERPROFILE", config.home); err != nil {
		return err
	}
	for _, key := range []string{"NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE"} {
		os.Unsetenv(key)
	}
	// A GUI-subsystem program never creates a terminal. This file is the
	// private diagnostic channel for a service that has no console output.
	logDir := filepath.Join(filepath.Dir(config.program), "logs")
	if config.layout == "work" {
		logDir = filepath.Join(config.program, "logs")
	}
	if err := os.MkdirAll(logDir, 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(
		filepath.Join(logDir, "native-launcher.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600,
	)
	if err != nil {
		return err
	}
	defer log.Close()
	for {
		exit, cause := launchOnce(config, log)
		if cause != nil {
			fmt.Fprintln(log, time.Now().UTC().Format(time.RFC3339), "native_start_failed")
		}
		if cause == nil && exit == 0 {
			return nil
		}
		if config.layout == "work" {
			if cause == nil && exit == 78 {
				return nil
			}
			return fmt.Errorf("Cloud-managed Agent failed")
		}
		time.Sleep(10 * time.Second)
	}
}
