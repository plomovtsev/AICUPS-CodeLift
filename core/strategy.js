let BaseStrategy = require('./basestrategy').BaseStrategy;

const EL_STATE = {
    waiting: 0,
    moving: 1,
    opening: 2,
    filling: 3,
    closing: 4
};
const PAS_STATE = {
    waitingForElevator: 1,
    movingToElevator: 2,
    returning: 3,
    movingToFloor: 4,
    usingElevator: 5,
    exiting: 6
};
const PAS_HORIZONTAL_SPEED = 2;
const CLOSE_DOORS_TICKS = 100;
const OPEN_DOORS_TICKS = 100;
const EMPTY_ONE_FLOOR_TICKS = 50;
const TAKE_ENEMY_PASS_DELAY_TICKS = 40;
const STOP_TICKS_AFTER_OPEN_DOORS = 40;
const EXIT_FROM_ELEVATOR_TICKS = 40;
const PHANTOM_TICKS = 500;
const TIME_TO_AWAY = 500;
const GAME_LEN = 7200;

const MAX_PLAN_LENGTH = 5;
const LOGS = true;
const AICUP_LOGS = false;

let curTick = 0;
let that;
let knownPhantomsCounter = 0;

class Strategy extends BaseStrategy {

    //takes original objects from server
    //prepare them and use that data to find best plan
    generatePlan(elevator, allPassengers) {

        let bestPlan = new Plan();

        const emulateAction = (action, elevator, passengers, curPlan) => {
            const tickAfterAction = curTick + curPlan.ticks + action.ticks;
            if (tickAfterAction <= GAME_LEN) { //add break on max plan ticks?
                let {newElev, newPass} = emulate(elevator, passengers, action);
                newPass = newPass.map(passengerz => removeWhoWontWait(newElev, passengerz));
                _generatePlan(newElev, newPass, curPlan.addAction(action, elevator));
            }
        };

        //new plan is better if it's score larger or, if scores equals, if it's ticks less
        const setAsBestIfBetter = (plan) => {
            const planScore = plan.score - plan.floorPenalty;
            const bestPlanScore = bestPlan.score - bestPlan.floorPenalty;
            if (planScore > bestPlanScore ||
                (planScore === bestPlanScore && plan.ticks < bestPlan.ticks)) {
                bestPlan = plan;
                //log(`${new Elevator(elevator).toJSON()} new plan: ${dropQuotes(JSON.stringify(plan))}`);
            }
        };

        //takes original elevator and prepared passengers
        const _generatePlan = (elevator, passengers, curPlan = new Plan()) => {
            if (curPlan.actions.length === MAX_PLAN_LENGTH) {
                setAsBestIfBetter(curPlan);
            } else {
                const curPassengersAmount = elevator.passengers.length;
                //1. if there is someone on the floor, try to fill elevator with different amounts of passengers
                //no need to try to wait passengers after waiting in prev action
                if (passengers[elevator.floor].length &&
                    (curPlan.isEmpty() || curPlan.lastAction() instanceof GoAction)) {
                    [20]
                        .map(n => n - curPassengersAmount) //how much is needed
                        .filter(n => n > 0)
                        .map(n => passengers[elevator.floor].slice(0, n)) //take first (best) n passengers
                        .filter(distinct) //same passenger arrays will produce same plan points so ignore them
                        .forEach(passengersToWait => {
                            const waitAction = new WaitAction(elevator, passengersToWait);
                            emulateAction(waitAction, elevator, passengers, curPlan);
                        });
                }
                //2. anyway, try to go to some floor, floors with max destinations check first
                [1, 2, 3, 4, 5, 6, 7, 8, 9]
                    .map(i => elevator.passengers.filter(p => p.destFloor === i))
                    .map((p, i) => {
                        p.floor = i + 1; //set dest floor to passengers array
                        return p;
                    })
                    .sort((p1, p2) => p2.length - p1.length)
                    .forEach(passengerz => {
                        //there is somebody in elevator wanting on passengerz.floor
                        if (passengerz.length) {
                            const goAction = new GoAction(elevator, passengerz.floor, passengerz);
                            emulateAction(goAction, elevator, passengers, curPlan);
                        //there is no one in elevator wanting on passengerz.floor
                        //then check if someone is staying on that floor
                        } else if (passengerz.floor !== elevator.floor && passengers[passengerz.floor].length) {
                            const goAction = new GoAction(elevator, passengerz.floor);
                            emulateAction(goAction, elevator, passengers, curPlan);
                        }
                    });
                setAsBestIfBetter(curPlan);
            }
        };

        _generatePlan(elevator, groupPassengersByFloorAndSort(elevator, allPassengers));
        return bestPlan;
    }

    onTick(myPassengers, myElevators, enemyPassengers, enemyElevators) {
        that = this;
        curTick += 1;
        if (curTick === 1)
            console.time("Execution time");
        const allPassengers = myPassengers.map(p => new Passenger(p)).concat(enemyPassengers.map(p => new Passenger(p)));
        const myElevatorz = copyElevators(myElevators);
        const enemyElevatorz = copyElevators(enemyElevators);
        updatePhantomPassengers(myElevatorz, enemyElevatorz, allPassengers);
        //log('phantoms: ' + PHANTOM_PASSENGERS.filter(p => p).map(p => JSON.stringify(p)));
        updateLastInvited(allPassengers);
        addXToElevators(myElevators);
        updateClosingStates(myElevators.concat(enemyElevators));
        myElevators.forEach((elevator, ind) => {
            inviteAllWhoInvited(elevator, myPassengers, enemyPassengers);
            if (curTick < 6499 && !someoneWasBorn() && someoneInvited(elevator) && !someoneInvitedGoingToOpponent(elevator)) {
                //relax and wait for those who going to elevator
                //log(`${new Elevator(elevator).toJSON()} just wait for ${LAST_INVITED[elevator.id].filter(p => !p.isPhantom).length} passengers and ${LAST_INVITED[elevator.id].filter(p => p.isPhantom).length} phantoms`);
                elevator.goToFloor(elevator.floor);
                if (allInvitedCame(elevator) || somePhantomReborned(elevator) || elevator.passengers.length === 20) {
                    dropInvited(elevator);
                }
            } else {
                dropInvited(elevator);
                if (isStartFillingStage(elevator, myElevators, allPassengers)) {
                    let minFloor = [8, 7, 6, 4][ind];
                    const visiblePassengers = filterReservedPassengers(elevator, allPassengers);
                    const accessiblePassengers = removeWhoWontWait(elevator, visiblePassengers);
                    const passengersToWait = accessiblePassengers.filter(p => p.destFloor >= minFloor && p.floor === 1);
                    sortByScore(elevator, passengersToWait);
                    const goingToThisElevAmount = allPassengers.filter(p => {
                        return p.state === PAS_STATE.movingToElevator && p.elevator && p.elevator.id === elevator.id;
                    }).length;
                    const waitAction = new WaitAction(elevator, passengersToWait.slice(0, 20 - elevator.passengers.length - goingToThisElevAmount));
                    waitAction.execute(elevator, myPassengers, enemyPassengers);
                    reservePassengersForElevator(elevator, new Plan().addAction(waitAction));
                } else if (shouldGeneratePlan(elevator)) {
                    resetReserved(elevator);
                    const withPhantoms = injectPhantoms(elevator, allPassengers);
                    const visiblePassengers = filterReservedPassengers(elevator, withPhantoms);
                    let accessiblePassengers = removeWhoWontWait(elevator, visiblePassengers);
                    // accessiblePassengers = dropWhoWillBeEarlierTakenByEnemy(elevator, enemyElevators, accessiblePassengers);
                    const plan = this.generatePlan(elevator, accessiblePassengers);
                    if (!plan.isEmpty()) {
                        //have a plan -- execute it
                        plan.actions[0].execute(elevator, myPassengers, enemyPassengers);
                        reservePassengersForElevator(elevator, plan);
                    } else if (elevator.passengers.length) {
                        //no plan in remaining time but have passengers -- lift them as max as can
                        const passengersByDestFloor = groupBy(elevator.passengers, p => p.destFloor);
                        const inTimePassengers = passengersByDestFloor.filter((pArr, destFloor) => {
                            return pArr.length && (curTick + new GoAction(elevator, destFloor).ticks < GAME_LEN);
                        });
                        if (inTimePassengers.length) {
                            let bestFloor = inTimePassengers[0][0].destFloor;
                            let maxScore = new GoAction(elevator, bestFloor, inTimePassengers[0]).score;
                            inTimePassengers.forEach(pArr => {
                                const floor = pArr[0].destFloor;
                                const score = new GoAction(elevator, floor, pArr).score;
                                if (score > maxScore) {
                                    bestFloor = floor;
                                    maxScore = score;
                                }
                            });
                            //log(`${new Elevator(elevator).toJSON()} no plan, lift someone to ${bestFloor} floor for ${maxScore} score`);
                            elevator.goToFloor(bestFloor);
                        } else {
                            //log(`${new Elevator(elevator).toJSON()} no plan and have passengers in elevator but no time to lift someone`);
                        }
                    } else {
                        //no plan and no passengers -- go to potentially good floor
                        const floor = curTick <= 1400 ? 1 : (curTick <= 6000 ? 5 : 9);
                        //log(`${new Elevator(elevator).toJSON()} no plan and no passengers in elevator, go to potentially good floor ${floor}`);
                        elevator.goToFloor(floor);
                    }
                }
            }
        });
        if (curTick === GAME_LEN) {
            console.timeEnd("Execution time");
            console.log(`Predicted ${knownPhantomsCounter} phantom's destFloors by their pair`);
        }
    }
}

const LAST_INVITED = [[], [], [], [], [], [], [], [], []];
function inviteAllWhoInvited(elevator, myPassengers, enemyPassengers) {
    myPassengers.concat(enemyPassengers).forEach(p => {
        if (LAST_INVITED[elevator.id].find(pas => pas.id === p.id)) {
            p.setElevator(elevator);
        }
    });
}
function markAsInvited(elevator, invitedPassengers) {
    LAST_INVITED[elevator.id] = invitedPassengers;
}
function dropInvited(elevator) {
    LAST_INVITED[elevator.id] = [];
}
function someoneInvited(elevator) {
    return LAST_INVITED[elevator.id].length !== 0;
}
function someoneInvitedGoingToOpponent(elevator) {
    return LAST_INVITED[elevator.id].find(p => p.goingToOpponent(elevator))
}
function allInvitedCame(elevator) {
    const invited = LAST_INVITED[elevator.id];
    const came = invited.filter(p => p.state === PAS_STATE.usingElevator && p.elevator === elevator.id);
    return came.length === invited.length;
}
function somePhantomReborned(elevator) {
    return LAST_INVITED[elevator.id].find(p => p.isPhantom && p.ticksToReborn === -1);
}
function updateLastInvited(allPassengers) {
    LAST_INVITED.forEach(invitedPassengers => {
        invitedPassengers.forEach((invitedPas, i) => {
            const fresh = allPassengers.find(p => p.id === invitedPas.id);
            if (fresh) {
                invitedPassengers.splice(i, 1, new Passenger(fresh));
            } else if (invitedPas.isPhantom) {
                invitedPas.decTicksToReborn(1);
            }
        })
    });
}

//Map(passenger -> id of elevator which plans to get this passenger)
let RESERVED_PASSENGERS = [];
function resetReserved(elevator) {
    RESERVED_PASSENGERS.forEach((elevId, passId) => {
        if (elevId === elevator.id)
            RESERVED_PASSENGERS[passId] = undefined;
    });
}

function reservePassengersForElevator(elevator, plan) {
    plan.actions.forEach(action => {
        if (action instanceof WaitAction) {
            action.passengers.forEach(p => {
                RESERVED_PASSENGERS[p.id] = elevator.id;
            })
        }
    });
}

//Passengers who will reborn, each have passenger.ticksToReborn prop
const PHANTOM_PASSENGERS = [];
const PAS_VISITED = [];
function updatePhantomPassengers(myElevators, enemyElevators, allPassengers) {
    //update current
    PHANTOM_PASSENGERS.forEach((p, ind) => {
        if (p) {
            if (p.ticksToReborn === -1 || p.state === PAS_STATE.movingToFloor && p.destFloor === 1) {
                PHANTOM_PASSENGERS[ind] = undefined;
                myElevators.forEach(elev => {
                    if (elev.state === EL_STATE.filling && elev.floor === p.floor) {
                        dropInvited(elev);
                    }
                })
            } else {
                p.ticksToReborn -= 1;
            }
        }
    });
    const allElevators = myElevators.concat(enemyElevators);
    //add those who lifted to his destination floor by elevator
    allElevators.forEach(elev => {
        elev.passengers.forEach(p => {
            if (p.destFloor !== 1 && p.destFloor === elev.floor && !PHANTOM_PASSENGERS[p.id] && !pasFinished(p.id)) {
                markFloorAsVisited(p, elev.floor);
                PHANTOM_PASSENGERS[p.id] = p.makePhantom({
                    ticksToReborn: OPEN_DOORS_TICKS + EXIT_FROM_ELEVATOR_TICKS + PHANTOM_TICKS + 1,
                    x: elev.type === 'FIRST_PLAYER' ? -20 : 20,
                    floor: elev.floor
                });
                incRebornCount(p.id);
            }
        });
    });
    //add those who can't wait anymore and going to stairs
    allPassengers.forEach(p => {
        if (!PHANTOM_PASSENGERS[p.id] && //probably impossible with other predicates but anyway...
            !pasFinished(p.id) &&
            p.timeToAway === 0 &&
            p.destFloor !== 1 && (
                p.state === PAS_STATE.waitingForElevator ||
                p.state === PAS_STATE.movingToElevator ||
                p.state === PAS_STATE.returning)
        ) {
            markFloorAsVisited(p, p.destFloor);
            const oneFloorStairTicks = p.floor > p.destFloor ? 100 : 200;
            PHANTOM_PASSENGERS[p.id] = p.makePhantom({
                ticksToReborn: oneFloorStairTicks * Math.abs(p.destFloor - p.floor) + PHANTOM_TICKS + 1,
                x: p.type === 'FIRST_PLAYER' ? -20 : 20,
                floor: p.destFloor
            });
            incRebornCount(p.id);
        }
    });
}
function markFloorAsVisited(passenger, floor) {
    if (!PAS_VISITED[passenger.id]) {
        PAS_VISITED[passenger.id] = [];
    }
    PAS_VISITED[passenger.id].push(floor);
}

//Times each passenger already reborned
const REBORN_COUNT = [];
function pasFinished(id) {
    return REBORN_COUNT[id] && REBORN_COUNT[id] === 5;
}
function incRebornCount(id) {
    if (!REBORN_COUNT[id]) {
        REBORN_COUNT[id] = 1;
    } else {
        REBORN_COUNT[id] += 1;
    }
}

//MUTATES PASSENGERS!
function sortByScore(elevator, passengers) {
    const curPassengersAmount = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(floor => {
        return elevator.passengers.filter(p => p.destFloor === floor).length;
    });
    const score = p => {
        const curPasBonus = curPassengersAmount[p.destFloor] * 1000;
        const dist = Math.abs(elevator.x - p.x);
        const weight = p.weight * 100;
        const opponentTypeBonus = p.type === elevator.type ? 0 : 1000;
        const gameStartBonus = elevator.floor === 1 && curTick <= 1000 ? p.destFloor * 1100 : 0;
        return curPasBonus + opponentTypeBonus + gameStartBonus - dist - weight;
    };
    passengers.sort((p1, p2) => score(p2) - score(p1));
}

// Functions without side-effects --------------------------------------------------------------------------------------|

function groupPassengersByFloorAndSort(elevator, allPassengers) {
    const passengersByFloor = groupBy(allPassengers, p => p.floor);
    const curPassengersAmount = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(floor => {
        return elevator.passengers.filter(p => p.destFloor === floor).length;
    });
    //todo probably not only by destFloor but by same direction (top or bottom)
    const score = p => {
        const curPasBonus = curPassengersAmount[p.destFloor] * curPassengersAmount[p.destFloor] * 200;
        const dist = Math.abs(elevator.x - p.x);
        const weight = p.weight * 100;
        const opponentTypeBonus = p.type === elevator.type ? 0 : 1000;
        const gameStartBonus = elevator.floor === 1 && curTick <= 1000 ? p.destFloor * 1100 : 0;
        const destDistBonus = Math.abs(p.floor - p.destFloor) * 1000 * (opponentTypeBonus ? 2 : 1);
        return curPasBonus + opponentTypeBonus + gameStartBonus + destDistBonus - dist - weight;
    };
    passengersByFloor.forEach(passengerz => passengerz.sort((p1, p2) => {
        return score(p2) - score(p1);
    }));
    return passengersByFloor;
}

function groupBy(passengers, fun, makeCopies = true) {
    const res = [[], [], [], [], [], [], [], [], [], []];
    passengers.forEach(p => p && res[fun(p)].push(makeCopies ? new Passenger(p) : p));
    return res;
}

function filterReservedPassengers(elevator, allPassengers) {
    return allPassengers.filter(p => {
        const plannedByOtherElevator = RESERVED_PASSENGERS[p.id] && RESERVED_PASSENGERS[p.id] !== elevator.id;
        return !plannedByOtherElevator && (
                p.state === PAS_STATE.waitingForElevator ||
                p.state === PAS_STATE.returning ||
                p.state === PAS_STATE.movingToElevator && p.elevator === elevator.id
            );
    });
}

function removeWhoWontWait(elevator, allPassengers) {
    return allPassengers.filter(p => {
        const goAction = new GoAction(elevator, p.floor);
        const delay = p.type === elevator.type ? 0 : Math.max(0, OPEN_DOORS_TICKS + TAKE_ENEMY_PASS_DELAY_TICKS - elevator.timeOnFloor);
        const time2come = Math.floor(Math.abs(p.x - elevator.x) / PAS_HORIZONTAL_SPEED) + 1;
        return p.timeToAway > goAction.ticks + delay + time2come + 1; // +1 for some reason...
    });
}

function injectPhantoms(elevator, alivePassengers) {
    const aliveWithPhantoms = alivePassengers.slice();
    groupBy(PHANTOM_PASSENGERS, p => p.floor, false)
        .map((phantoms, floor) => {
            const ticksToThatFloor = new GoAction(elevator, floor).ticks;
            const rebornSoonPhantoms = phantoms.filter(p => ticksToThatFloor >= p.ticksToReborn - 300);
            //materialize only half of phantoms
            const phantomFactor = [0, 0, 0.9, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1];
            return rebornSoonPhantoms.slice(0, Math.floor(rebornSoonPhantoms.length * phantomFactor[floor]));
        }).forEach(phantoms => {
            phantoms.forEach(phantom => {
                const existingInd = aliveWithPhantoms.findIndex(alivePas => alivePas.id === phantom.id);
                if (existingInd > -1) { //replace with their phantom those who going stairs
                    aliveWithPhantoms.splice(existingInd, 1, phantom);
                } else {
                    aliveWithPhantoms.push(phantom);
                }
            });
        });
    return aliveWithPhantoms;
}

const WHEN_ELEV_STARTED_CLOSING = [];
function updateClosingStates(elevators) {
    elevators.forEach(elev => {
        if (elev.state === EL_STATE.closing && !WHEN_ELEV_STARTED_CLOSING[elev.id]) {
            WHEN_ELEV_STARTED_CLOSING[elev.id] = curTick;
        } else if (elev.state !== EL_STATE.closing && WHEN_ELEV_STARTED_CLOSING[elev.id]) {
            WHEN_ELEV_STARTED_CLOSING[elev.id] = false;
        }
    });
}
function dropWhoWillBeEarlierTakenByEnemy(myElevator, enemyElevators, passengers) {
    const dangerElevs = enemyElevators.filter(elev => {
        return [EL_STATE.closing, EL_STATE.waiting, EL_STATE.moving, EL_STATE.opening].includes(elev.state);
    });
    if (dangerElevs.length) {
        const newPassengers = passengers.filter(p => !p.isPhantom);
        dangerElevs.forEach(elev => {
            const pasGroupedByFloor = groupBy(newPassengers, p => p.floor);
            const nextFloor = elev.state === EL_STATE.opening ? elev.floor : elev.nextFloor;
            const nextFloorPassengers = pasGroupedByFloor[nextFloor];
            if (nextFloorPassengers.length) {
                const my = [];
                const his = [];
                nextFloorPassengers.forEach(p => {
                    if (p.type === myElevator.type) {
                        my.push(p);
                    } else {
                        his.push(p);
                    }
                });
                const myTime = new GoAction(myElevator, nextFloor).ticks;
                let hisTime;
                if (elev.state === EL_STATE.closing) {
                    const closingTicks = CLOSE_DOORS_TICKS - (curTick - WHEN_ELEV_STARTED_CLOSING[elev.id]);
                    hisTime = closingTicks + new GoAction(elev, nextFloor).movingTicks + OPEN_DOORS_TICKS;
                } else if (elev.state === EL_STATE.moving || elev.state === EL_STATE.waiting) {
                    hisTime = new GoAction(elev, nextFloor).movingTicks + OPEN_DOORS_TICKS;
                } else if (elev.state === EL_STATE.opening) {
                    hisTime = OPEN_DOORS_TICKS - elev.timeOnFloor;
                }
                const willTakeMyEarlier = my.length && (
                    myTime > hisTime + TAKE_ENEMY_PASS_DELAY_TICKS ||
                    myTime === hisTime + TAKE_ENEMY_PASS_DELAY_TICKS && Math.abs(my[0].x - myElevator.x) > Math.abs(my[0].x - elev.x)
                );
                const willTakeHisEarlier = his.length && (
                    myTime + TAKE_ENEMY_PASS_DELAY_TICKS > hisTime ||
                    myTime + TAKE_ENEMY_PASS_DELAY_TICKS === hisTime && Math.abs(his[0].x - myElevator.x) > Math.abs(his[0].x - elev.x)
                );
                let potentialTaken = (willTakeMyEarlier ? my : []).concat(willTakeHisEarlier ? his : []);
                const freeSlots = 20 - elev.passengers.length + elev.passengers.filter(p => p.destFloor === nextFloor).length;
                if (potentialTaken.length > freeSlots) {
                    const destFloors = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                    elev.passengers.forEach(p => destFloors[p.destFloor] += 1);
                    potentialTaken.sort((p1, p2) => destFloors[p2.destFloor] - destFloors[p1.destFloor]);
                    potentialTaken = potentialTaken.slice(0, freeSlots);
                }
                potentialTaken.forEach(takenPas => {
                    const ind = newPassengers.findIndex(np => np.id === takenPas.id);
                    if (ind) {
                        newPassengers.splice(ind, 1);
                        log(`${myElevator.id} is slower than ${elev.id} to take passenger from ${nextFloor} floor`);
                    }
                });
            }
        });
        return newPassengers;
    }
    return passengers;
}

function emulate(elevator, passengers, action) {
    //creating copies of elevator and passengers
    let newElev = new Elevator(elevator);
    let newPass = passengers.map(passengerz => {
        return passengerz
            .map(p => {
                const newP = new Passenger(p);
                newP.decTimeToAway(action.ticks);
                return newP;
            })
            //drop passengers who will go to stairs while action executes
            .filter(p => p.timeToAway > 0);
    });
    if (action instanceof WaitAction) {
        //add new passengers to elevator
        const comingPassengers = action.passengers.map(p => new Passenger(p));
        newElev.setPassengers(newElev.passengers.concat(comingPassengers));
        //remove them from waiting list
        newPass[elevator.floor] = subtract(newPass[elevator.floor], comingPassengers);
    } else if (action instanceof GoAction) {
        //remove passengers from elevator
        newElev.setPassengers(subtract(newElev.passengers, action.passengers));
        newElev.setFloor(action.floor);
        newElev.setTimeOnFloor(OPEN_DOORS_TICKS);
    }
    return {
        newElev,
        newPass
    }
}

function subtract(initial, subtractor) {
    return initial.filter(p => {
        return !subtractor.find(ap => ap.id === p.id);
    })
}

function distinct(passengersToWait, i, arr) {
    return arr.findIndex(pass => pass.length === passengersToWait.length) === i;
}

function shouldGeneratePlan(elevator) {
    return elevator.state === EL_STATE.filling;
}

function isStartFillingStage(elevator, myElevators, allPassengers) {
    const firstFloorElevs = myElevators.filter(elev => elev.floor === 1 && elev.state === EL_STATE.filling);
    const freeElevatorSlots = firstFloorElevs.reduce((acc, elev) => acc + 20 - elev.passengers.length, 0);
    const goingToPas = allPassengers.filter(p => p.state === PAS_STATE.movingToElevator && !p.goingToOpponent(elevator)).length;
    const neededPas = freeElevatorSlots - goingToPas;
    const waitingPas = allPassengers.filter(pas => {
        return pas.floor === 1 && (
                pas.state === PAS_STATE.waitingForElevator ||
                pas.state === PAS_STATE.returning
            )
    }).length;
    const enoughPasWillBorn = neededPas < (Math.floor((2000 - curTick) / 20) * 2 + waitingPas);
    return curTick < 2000 && elevator.passengers.length < 20 && elevator.floor === 1 && enoughPasWillBorn;
}

function copyElevators(elevators) {
    return elevators.map(el => {
        const newElev = new Elevator(el);
        //make copies of passengers so that they have makePhantom method
        newElev.setPassengers(el.passengers.map(p => new Passenger(p)));
        return newElev;
    });
}

function someoneWasBorn() {
    return curTick <= 2001 && (curTick % 20 === 1);
}

// ---------------------------------------------------------------------------------------------------------------------|

class WaitAction {
    constructor(elevator, passengersToWait) {
        this.elevator = elevator;
        this.passengers = passengersToWait;
    }
    get ticks() {
        const timeOnFloor = this.elevator.timeOnFloor;
        let farestPassengerTime = 0;
        this.passengers.forEach(p => {
            const timeToReborn = p.ticksToReborn || 0;
            const timeToCome = Math.floor(Math.abs(p.x - this.elevator.x) / PAS_HORIZONTAL_SPEED) + 1;
            const enemyDelay = p.type === this.elevator.type ? 0 : Math.max(0, TAKE_ENEMY_PASS_DELAY_TICKS - timeOnFloor);
            const factTime = timeToReborn + timeToCome + enemyDelay;
            farestPassengerTime = Math.max(farestPassengerTime, factTime);
        });
        const minTimeOnFloor = Math.max(0, OPEN_DOORS_TICKS + STOP_TICKS_AFTER_OPEN_DOORS - timeOnFloor);
        return Math.max(minTimeOnFloor, farestPassengerTime);
    }
    get score() {
        return this.elevator.floor === 9 ? this.passengers.reduce((acc ,p) => acc + (p.type === this.elevator.type ? 10 : 20), 0) : 0;
    }
    //MUTATES PASSENGERS!
    execute(elevator, myPassengers, enemyPassengers) {
        this._setElevatorToPassengers(myPassengers);
        this._setElevatorToPassengers(enemyPassengers);
        markAsInvited(elevator, this.passengers);
        //log(`Elev ${elevator.id} will wait for ${this.passengers.length} passengers (${this.passengers.filter(p => p.isPhantom).length} phantoms)`);
    }
    _setElevatorToPassengers(passengers) {
        passengers.forEach(p => {
            if (this.passengers.find(wp => wp.id === p.id)) {
                p.setElevator(this.elevator);
            }
        })
    }
    toJSON() {
        return `WaitAction(pass: ${this.passengers.length}, ticks: ${this.ticks})`;
    }
}

class GoAction {
    constructor(elevator, floor, passengers = []) {
        this.elevator = elevator;
        this.floor = floor;
        this.passengers = passengers;
    }
    get ticks() {
        if (Math.abs(this.elevator.y - Math.floor(this.elevator.y)) < 0.0001 && this.elevator.floor === this.floor) {
            return Math.max(0, OPEN_DOORS_TICKS - this.elevator.timeOnFloor);
        } else {
            const minTimeOnFloor = Math.max(0, OPEN_DOORS_TICKS + STOP_TICKS_AFTER_OPEN_DOORS - this.elevator.timeOnFloor);
            return minTimeOnFloor + CLOSE_DOORS_TICKS + this.movingTicks + OPEN_DOORS_TICKS;
        }
    }
    get movingTicks() {
        let mt = 0;
        if (this.passengers.length === 0 || this.floor < this.elevator.floor) {
            mt = Math.abs(this.elevator.y - this.floor) * EMPTY_ONE_FLOOR_TICKS;
        } else {
            const weightFactor = this.elevator.passengers.reduce((acc, p) => acc * p.weight, 1);
            const overweightFactor = this.elevator.passengers.length > 10 ? 1.1 : 1;
            const oneFloorTicks = EMPTY_ONE_FLOOR_TICKS * weightFactor * overweightFactor;
            mt = Math.abs(this.elevator.y - this.floor) * oneFloorTicks;
        }
        mt = Math.abs(mt - Math.floor(mt)) < 0.00001 ? mt : (Math.floor(mt) + 1);
        return mt;
    }
    get score() {
        return this.passengers.reduce((acc, p) => {
            return acc + Math.abs(p.fromFloor - p.destFloor) * 10 * (this.elevator.type === p.type ? 1 : 2);
        }, 0);
    }
    //MUTATES ELEVATOR!
    execute(elevator, myPassengers, enemyPassengers) {
        elevator.goToFloor(this.floor);
        dropInvited(elevator);
        //log(`Elev ${elevator.id} will go to ${this.floor} to lift ${this.passengers.length} passenger(s)`);
    }
    toJSON() {
        return `GoAction(floor: ${this.floor}, pass: ${this.passengers.length}, ticks: ${this.ticks})`;
    }
}

class Plan {
    constructor() {
        this.actions = [];
        this.ticks = 0;
        this.score = 0;
        this.floorPenalty = 0;
    }
    //creates copy
    addAction(action, elevator) {
        const newPlan = new Plan();
        newPlan.ticks = this.ticks + action.ticks;
        newPlan.score = this.score + action.score;
        if (this.actions.length) {
            //todo penalty for going in area where less my current passengers want to be?
            //penalty for distance which would be passed by lift
            const penalty = this.actions
                .map(a => a.floor)
                .filter(f => f !== undefined)
                .reduce((acc, floor, i, floors) => {
                    return acc + Math.abs(floor - (i === 0 ? elevator.floor : floors[i - 1]));
                }, 0) * 80;
            newPlan.floorPenalty = this.floorPenalty + penalty;
        }
        newPlan.actions = this.actions.slice();
        newPlan.actions.push(action);
        return newPlan;
    }
    toJSON() {
        return `{ticks: ${this.ticks}, score: ${this.score}, actions: ${JSON.stringify(this.actions)}}`;
    }
    isEmpty() {
        return this.actions.length === 0;
    }
    lastAction() {
        return this.actions[this.actions.length - 1];
    }
}

class Elevator {
    constructor({id, _x, _y, _passengers, _state, _speed, _floor, _nextFloor, _timeOnFloor, _type}) {
        this.id = id;
        this._x = _x;
        this.x = _x;
        this._y = _y;
        this.y = _y;
        this._passengers = _passengers.map(p => new Passenger(p));
        this.passengers = this._passengers;
        this._state = _state;
        this.state = _state;
        this._speed = _speed;
        this.speed = _speed;
        this._floor = _floor;
        this.floor = _floor;
        this._nextFloor = _nextFloor;
        this.nextFloor = _nextFloor;
        this._timeOnFloor = _timeOnFloor;
        this.timeOnFloor = _timeOnFloor;
        this._type = _type;
        this.type = _type;
    }

    setPassengers(passengers) {
        this._passengers = passengers;
        this.passengers = passengers;
    }

    setFloor(floor) {
        this._floor = floor;
        this.floor = floor;
    }

    setTimeOnFloor(time) {
        this._timeOnFloor = time;
        this.timeOnFloor = time;
    }

    toJSON() {
        return `Elev(id: ${this.id}, state: ${this.state}, floor: ${this.floor})`;
    }
}

class Passenger {
    constructor({id, _elevator, _x, _y, _state, _timeToAway, _fromFloor, _destFloor, _type, _floor, _weight, ticksToReborn}) {
        this.id = id;
        this._elevator = _elevator;
        this.elevator = _elevator;
        this._fromFloor = _fromFloor;
        this.fromFloor = _fromFloor;
        this._destFloor = _destFloor;
        this.destFloor = _destFloor;
        this._timeToAway = _timeToAway;
        this.timeToAway = _timeToAway;
        this._state = _state;
        this.state = _state;
        this._floor = _floor;
        this.floor = _floor;
        this._type = _type;
        this.type = _type;
        this._x = _x;
        this.x = _x;
        this._y = _y;
        this.y = _y;
        this._weight = _weight;
        this.weight = _weight;
        this.ticksToReborn = ticksToReborn;
    }

    decTimeToAway(dt) {
        this._timeToAway -= dt;
        this.timeToAway = this._timeToAway;
    }

    decTicksToReborn(dt) {
        this.ticksToReborn -= dt;
    }

    makePhantom({ticksToReborn, x, floor}) {
        const pairId = this.id + (this.id % 2 === 0 ? -1 : 1);
        let destFloor;
        if (PAS_VISITED[pairId] && (PAS_VISITED[pairId].length > PAS_VISITED[this.id].length)) {
            destFloor = PAS_VISITED[pairId][PAS_VISITED[this.id].length + 1];
            knownPhantomsCounter += 1;
        } else {
            destFloor = PAS_VISITED[this.id].length === 4 ? 1 : randomIntFromTo(1, 9);
        }
        while (PAS_VISITED[this.id].find(f => f === destFloor)) {
            destFloor = randomIntFromTo(1, 9);
        }
        return new Passenger({
            id: this.id,
            _elevator: undefined,
            _fromFloor: floor,
            _destFloor: destFloor,
            _timeToAway: TIME_TO_AWAY,
            _state: PAS_STATE.waitingForElevator,
            _floor: floor,
            _type: this.type,
            _x: x,
            _y: floor,
            _weight: this.weight,
            ticksToReborn: ticksToReborn
        });
    }

    get isPhantom() {
        return this.ticksToReborn !== undefined;
    }

    goingToOpponent(myElevator) {
        return this.elevator && this.state === PAS_STATE.movingToElevator && (this.elevator + myElevator.id) % 2 !== 0
    }

    toJSON() {
        return `Pass(state: ${this.state}, floor: ${this.floor}, elev: ${(this.elevator && this.elevator.id) || this.elevator})`;
    }
}

function log(text) {
    if (LOGS)
        console.log(`[tick ${curTick}] ${text}`);
    if (AICUP_LOGS)
        that.debug(text);
}

function dropQuotes(s) {
    return s.replace(/\\\"/g, '');
}

function addXToElevators(elevators) {
    elevators.forEach((elev, i) => {
        const sign = elev.type === 'FIRST_PLAYER' ? -1 : 1;
        elev.x = sign * (60 + 80 * i);
        elev._x = elev.x;
    });
}

function randomIntFromTo(from, to) {
    return Math.floor(Math.random() * (to - from + 1) + from);
}

module.exports.Strategy = Strategy;
