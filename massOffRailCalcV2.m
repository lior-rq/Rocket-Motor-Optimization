%filename: massOffRailCalcRevision
%By: Cooper Koch and Joshua Lance
%IREC Propulsion
%Date: 1/28/26
%Synopsis: This code is used to calculate the maximum mass allowed for a
%specific rocket motor to be used while still maintaining the speed needed
%off the launch rod

%Set Variables
clc;
clear;
Rod_Length_Effective = 18 * 0.3048; % m
velocity_offRod = 25; % m/s

filenames = ["text 1", "text 2"];
%take in burnsim and openmotor files

%Select and read .eng file
[filename1, pathname1] = uigetfile('*.eng', 'Select first .eng file');
[filename2, pathname2] = uigetfile('*.eng', 'Select second .eng file');
engpath1 = fullfile(pathname1, filename1); % get full path
engpath2 = fullfile(pathname2, filename2);
filenames(1)=filename1;
filenames(2)=filename2;

motor1  = readENG(engpath1); %read motor file 
time1   = motor1.time;%extract time variable
time1(end) = time1(end) + 0.01;
thrust1 = motor1.thrust; %extract thrust variable
motor2  = readENG(engpath2); 
time2   = motor2.time; 
thrust2 = motor2.thrust; 
[thrust2, i2, i1] = unique(thrust2);
time2 = time2(i2);

%Thrust interpolation 
T1 = @(t) interp1(time1, thrust1, t, 'linear', 0);
T2 = @(t) interp1(time2, thrust2, t, 'linear', 0);

j=1;
%test velocities in target range
for i =20:.1:35
%Solve for maximum mass 
velo(j)=i;
m_max1(j) = 2.20462*fzero(@(m) railExitVelocity(m, T1, Rod_Length_Effective) ...
              - i, [1 1000]); %find function for exit velocity with variable masses
m_max2(j) = 2.20462*fzero(@(m) railExitVelocity(m, T2, Rod_Length_Effective) ...
              - i, [1 1000]); 

j=j+1;
end



hold on
plot(velo,m_max1,"g-");
plot(velo,m_max2,"r-");
grid on



xlabel("Speed Off Rail (m/s)")
ylabel("Weight (lb)")
legend(filenames(1),filenames(2),'Location',"northeast")

hold off

%Display calcualted value
%fprintf('The maximum weight allowed for the %s motor is %f lbm \n',motor.name,m_max*2.20462)

%function definitions
function dxdt = railEOM(t,x,m,T) %define ode for velocity (dx/dt)
    dxdt = [
        x(2); %dx/dt 
        (T(t) - m*9.81*cosd(7))/m %acceleartion (F/m)
    ];
end

%define rail exit event
function [value,isterminal,direction] = railExit(~,x,L) % ~ represents 
    value = x(1) - L; %sets x as zero when rail exit happens
    isterminal = 1;
    direction = 1;
end
%define v_exit function
function v_exit = railExitVelocity(m,T,L) 
    opts = odeset('Events', @(t,x) railExit(t,x,L)); %sets event for ode
    [~,x] = ode45(@(t,x) railEOM(t,x,m,T), [0 5], [0;0], opts); %call ode function
    v_exit = x(end,2); %output velocity at exit
end

function motor = readENG(filename) %organizes and reads .eng file data


%take file name and format
lines = readlines(filename);
lines = strip(lines);
lines(lines == "" | startsWith(lines,";")) = [];

%divide lines into individual
header = split(lines(1));

%assign different object properties to values
motor.name        = header(1);
motor.diameter_mm = str2double(header(2));
motor.length_mm   = str2double(header(3));
motor.delays      = header(4);
motor.m_prop_kg   = str2double(header(5));
motor.I_total     = str2double(header(6));

data = split(lines(2:end));
data = str2double(data);

motor.time   = data(:,1);
motor.thrust = data(:,2);

end
